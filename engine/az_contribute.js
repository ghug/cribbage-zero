#!/usr/bin/env node
/* engine/az_contribute.js — contribute self-play from a COMPUTER to the shared net (multi-core).
 *
 * A headless Node port of local.html's trainer, parallelised across cores: the MAIN thread owns the net
 * (training + GitHub sync); N WORKER threads each generate self-play against a net snapshot every round
 * and ship the labelled samples back. Self-play is the expensive part and fans out cleanly; training
 * stays single-writer in main. It pulls the net from the GitHub `net` branch, trains, and force-pushes it
 * back. The net file is weights + iter + games, so the phone and this script are interchangeable:
 * each resumes from whatever the other last pushed.
 *
 * SINGLE-WRITER LEARNER: only ONE machine trains + pushes the net (force-push). To use MORE machines,
 * run them as ACTORS (--actor): they self-play and upload sample shards to the Cloudflare data bus; the
 * single learner drains the bus into its replay buffer alongside its own self-play. The learner is also
 * an actor (its self-play goes straight into its buffer). Never run two learners.
 *
 * Usage:
 *   LEARNER:  CZ_TOKEN=<pat> [CZ_BUS_URL=.. CZ_BUS_TOKEN=<trainer-token>] node engine/az_contribute.js [gamesPerRound=500] [sims=40]
 *   ACTOR:    CZ_BUS_URL=.. CZ_BUS_TOKEN=<worker-token> node engine/az_contribute.js --actor [gamesPerRound] [sims]
 *   The learner trains from a bounded REPLAY BUFFER (constant memory): each round self-plays gamesPerRound
 *   against a fresh net snapshot, drains the bus, runs shuffled mini-batch SGD from the window, and pushes the
 *   net every CZ_PUSH_GAMES games (+ on wind-down). An actor only self-plays → uploads shards → refreshes the
 *   net from GitHub when the learner advances it (no GitHub token needed — it reads the public net).
 * Env:
 *   CZ_TOKEN       GitHub PAT (learner only — Contents:write to push the net)
 *   CZ_REPO        target repo (default "ghug/cribbage-zero")
 *   CZ_WORKERS     self-play worker threads (default: CPU cores − 1)
 *   CZ_CKPT        local checkpoint path (default: engine/az_contribute_ckpt.json)
 *   CZ_PUSH_GAMES  games between GitHub pushes (default 10000)
 *   CZ_BUF / CZ_BATCH   replay buffer max samples (200000) / SGD mini-batch size (256)
 *   CZ_BUS_URL     data-bus Worker URL (enables actor uploads / learner draining)
 *   CZ_BUS_TOKEN   bus bearer token — the WORKER token for actors, the TRAINER token for the learner
 *   CZ_SHARD_MAX / CZ_BUS_LIMIT   samples per uploaded shard (2000) / shards drained per round (400)
 *   CZ_ID          stable id for this device (default: hostname-pid)
 * Flags:
 *   --actor     run as an actor (upload shards, no train/push); --dry  no upload/push (smoke test)
 *
 * It NEVER overwrites the cloud net with a blank one: it only starts fresh when the branch genuinely has
 * no net (a clean 404). If it can't read the net, or the net is a different architecture, it refuses to
 * start (resetting the net is a deliberate act, not something a contributor can trip into). Ctrl-C does a
 * final push, then exits.
 */
"use strict";
const os = require("os");
const fs = require("fs");
const path = require("path");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const { makeRng, selfPlay, freshNet, netToObj, netFromObj, writeAtomic, INPUT_DIM } = require("./az_common.js");
const { makeSync } = require("./az_sync.js");   // data-bus client (shards queue); only used when CZ_BUS_URL is set

/* ---------------- WORKER: self-play against a net snapshot, hand samples back ---------------- */
if (!isMainThread) {
  const rng = makeRng((workerData.seed ^ (Date.now() & 0xffff)) >>> 0);
  let net = null;
  parentPort.on("message", (msg) => {
    if (msg.net) net = netFromObj(msg.net);
    const stop = workerData.stop;                 // SharedArrayBuffer-backed flag set on wind-down
    let data = [], played = 0;
    for (let g = 0; g < msg.games; g++) {
      if (stop && Atomics.load(stop, 0)) break;   // wind-down: finish the in-progress game, don't start the next
      data = data.concat(selfPlay(net, workerData.sims, workerData.cpuct, rng));
      played++;
    }
    parentPort.postMessage({ samples: data, played: played });   // {x,pi,legal,z} arrays + games actually played
  });
  return;
}

/* ---------------- MAIN (learner): pull net, fan self-play across workers, train, push ---------------- */
const HIDDEN = [256, 256, 256, 256], LR = 0.02, CPUCT = 1.5;
const CHUNK = parseInt(process.argv[2], 10) || 500;        // games per round (per net snapshot) — small so the net refreshes often
const SIMS = parseInt(process.argv[3], 10) || 40;
const PUSH_EVERY = parseInt(process.env.CZ_PUSH_GAMES, 10) || 10000;   // games between GitHub pushes (decoupled from rounds)
const BUF_CAP = parseInt(process.env.CZ_BUF, 10) || 200000;           // replay buffer: max samples kept (sliding window, ~480 MB)
const BATCH = parseInt(process.env.CZ_BATCH, 10) || 256;              // SGD mini-batch size
const TRAIN_PER_SAMPLE = 2;                                           // gradient updates applied per NEW sample (≈ the old 2 epochs)
const WORKERS = Math.max(1, parseInt(process.env.CZ_WORKERS, 10) || (os.cpus().length - 1));
const DRY = process.argv.includes("--dry");
const REPO = process.env.CZ_REPO || "ghug/cribbage-zero";
const TOKEN = process.env.CZ_TOKEN || "";
// data bus (optional): ACTOR uploads self-play shards to the bus + pulls the net from GitHub (no train/push);
// the learner drains the bus into its replay buffer alongside its own self-play.
const ACTOR = process.argv.includes("--actor");
const BUS_URL = process.env.CZ_BUS_URL || "";
const BUS_TOKEN = process.env.CZ_BUS_TOKEN || "";
const SHARD_MAX = parseInt(process.env.CZ_SHARD_MAX, 10) || 2000;     // samples per uploaded shard (keeps a D1 row small)
const BUS_LIMIT = parseInt(process.env.CZ_BUS_LIMIT, 10) || 400;      // max shards the learner drains per round
const BRANCH = "net", CKPATH = "checkpoints/az_checkpoint.json", INFOPATH = "checkpoints/info.json";
const LOCAL = process.env.CZ_CKPT || path.join(__dirname, "az_contribute_ckpt.json");   // crash-safety: saved every round, no network
const rng = makeRng((Date.now() ^ (process.pid << 8)) >>> 0);
const now = () => new Date().toLocaleTimeString();
const log = (m) => console.log(`[${now()}] ${m}`);

if (!TOKEN && !DRY) { console.error("az_contribute: set CZ_TOKEN (a GitHub PAT) or pass --dry"); process.exit(1); }

// --- the net file is WEIGHTS + iter + games (the net's training position) ---
function ckpt(net, iter, games) { const o = netToObj(net, iter); o.games = games; return o; }   // {iter,games,nIn,hidden,nPol,W,b,...}
function validCkpt(o) {
  if (!o || o.nIn !== INPUT_DIM || !Array.isArray(o.hidden) || o.hidden.length !== HIDDEN.length) return false;
  for (let i = 0; i < HIDDEN.length; i++) if (o.hidden[i] !== HIDDEN[i]) return false;
  if (!Array.isArray(o.W) || o.W.length !== HIDDEN.length || !Array.isArray(o.W[0]) || !Array.isArray(o.W[0][0]) || o.W[0][0].length !== o.nIn) return false;
  return Array.isArray(o.b) && Array.isArray(o.Wv) && Array.isArray(o.Wp) && Array.isArray(o.bp);
}

// --- GitHub net-branch sync (orphan force-push = always one commit), ported from local.html ---
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s) => Buffer.from(s, "base64").toString("utf8");
async function gh(method, path, body) {
  const res = await fetch("https://api.github.com" + path, {
    method, headers: { Authorization: "Bearer " + TOKEN, Accept: "application/vnd.github+json",
      "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cribbage-zero-contribute" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text(); let j = null; try { j = JSON.parse(txt); } catch (e) {}
  if (res.status >= 400) throw new Error(method + " " + path.split("?")[0] + " -> " + res.status + (j && j.message ? " " + j.message : ""));
  return { status: res.status, body: j };
}
// read headers for a public GET — auth only when a GitHub token is set (actors read the public net token-lessly)
function readHeaders(accept) { const H = { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cribbage-zero-contribute" }; if (TOKEN) H.Authorization = "Bearer " + TOKEN; return H; }
async function pullNet() {   // RAW media type — the net is multi-MB and the JSON repr only inlines content ≤1MB
  const res = await fetch("https://api.github.com/repos/" + REPO + "/contents/" + encodeURIComponent(CKPATH) + "?ref=" + BRANCH, { headers: readHeaders("application/vnd.github.raw") });
  if (res.status === 404) return null;
  if (res.status >= 400) throw new Error("pull net -> " + res.status);
  return JSON.parse(await res.text());
}
// small "is the cloud net newer?" probe — read FIRST so we don't pull the multi-MB net unless we must.
async function pullInfo() {   // {games, iter} or null if the info file doesn't exist yet
  const res = await fetch("https://api.github.com/repos/" + REPO + "/contents/" + encodeURIComponent(INFOPATH) + "?ref=" + BRANCH, { headers: readHeaders("application/vnd.github.raw") });
  if (res.status === 404) return null;
  if (res.status >= 400) throw new Error("pull info -> " + res.status);
  return JSON.parse(await res.text());
}
async function pushNet(net, iter, games) {   // pushes the net file + the small info file; progress.csv is on its own branch
  const netBlob = await gh("POST", "/repos/" + REPO + "/git/blobs", { content: b64(JSON.stringify(ckpt(net, iter, games))), encoding: "base64" });
  const infoBlob = await gh("POST", "/repos/" + REPO + "/git/blobs", { content: b64(JSON.stringify({ games, iter })), encoding: "base64" });
  const tree = await gh("POST", "/repos/" + REPO + "/git/trees", { tree: [
    { path: CKPATH, mode: "100644", type: "blob", sha: netBlob.body.sha },
    { path: INFOPATH, mode: "100644", type: "blob", sha: infoBlob.body.sha },
  ] });
  const commit = await gh("POST", "/repos/" + REPO + "/git/commits", { message: "net @ iter " + iter + " (" + games + " games)", tree: tree.body.sha, parents: [] });
  let ref; try { ref = await gh("GET", "/repos/" + REPO + "/git/ref/heads/" + BRANCH); } catch (e) { ref = { status: 404 }; }
  if (ref.status === 200) await gh("PATCH", "/repos/" + REPO + "/git/refs/heads/" + BRANCH, { sha: commit.body.sha, force: true });
  else await gh("POST", "/repos/" + REPO + "/git/refs", { ref: "refs/heads/" + BRANCH, sha: commit.body.sha });
}

// SGD from the replay buffer: `steps` mini-batches of `batch` samples drawn at random WITH replacement —
// the random draw decorrelates the otherwise-correlated within-game positions (lower-variance gradients).
function trainReplay(net, buf, steps, batch, lr, rng) {
  let loss = 0, n = 0;
  for (let s = 0; s < steps; s++) for (let b = 0; b < batch; b++) { const d = buf[(rng() * buf.length) | 0]; loss += net.trainStep(d.x, d.z, d.pi, d.legal, lr); n++; }
  return n ? loss / n : 0;
}

(async () => {
  let net, iter = 0, games = 0;
  const sync = (BUS_URL && BUS_TOKEN) ? makeSync({ apiUrl: BUS_URL, token: BUS_TOKEN, workerId: "az-" + (process.env.CZ_ID || (os.hostname() + "-" + process.pid)).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 56) }) : null;

  if (ACTOR) {   // actor: play against the GitHub net, upload self-play shards to the bus (no train, no net push)
    if (!sync) { console.error("az_contribute --actor: set CZ_BUS_URL and CZ_BUS_TOKEN"); process.exit(1); }
    let remote; try { remote = await pullNet(); } catch (e) { console.error("actor: can't read the net (" + e.message + ")"); process.exit(1); }
    if (!remote || !validCkpt(remote)) { console.error("actor: no compatible net on GitHub yet — start the learner first"); process.exit(1); }
    net = netFromObj(remote); iter = remote.iter || 0;
    log("ACTOR — playing against net iter " + iter + " (" + (remote.games || 0).toLocaleString() + " games); uploading shards to the bus" + (DRY ? " [DRY: not uploading]" : ""));
  } else {

  // local checkpoint first — its games count gates whether we even need to download the multi-MB cloud net
  let local = null;
  try { local = JSON.parse(fs.readFileSync(LOCAL, "utf8")); } catch (e) {}
  const localOk = local && validCkpt(local);
  if (local && !localOk) log("local checkpoint is a different architecture — ignoring it");
  const localGames = localOk ? (local.games || 0) : -1;

  if (TOKEN) {
    // 1. cheap probe: the info file reports the cloud net's games count without downloading the whole net
    let info = null, infoFailed = false;
    try { info = await pullInfo(); } catch (e) { infoFailed = true; log("info check failed (" + e.message + ") — checking the net file"); }

    if (info && (info.games || 0) <= localGames) {
      log("info: cloud net (" + (info.games || 0).toLocaleString() + " games) not newer than local (" + localGames.toLocaleString() + ") — skipping the net download");
      // net stays unset here; the local override below resumes from the local checkpoint
    } else {
      // cloud is newer (per info), OR there's no info file yet / it failed — read the net file itself
      if (info) log("info: cloud net (" + (info.games || 0).toLocaleString() + " games) is newer than local — pulling net");
      else if (!infoFailed) log("no info file yet — checking the net file");
      log("pulling net from " + REPO + " @ " + BRANCH + " …");
      let remote, pullErr = null;
      try { remote = await pullNet(); } catch (e) { pullErr = e; }   // pullNet returns null on a clean 404, throws otherwise
      if (pullErr) {                                       // couldn't READ the cloud net — refuse, so we never overwrite it blind
        log("pull failed: " + pullErr.message);
        if (!DRY) { console.error("az_contribute: refusing to start — can't read the cloud net, and training would push a net that overwrites it. Fix the token/connection and retry."); process.exit(1); }
        log("dry run — training a throwaway local net (won't push)");
      } else if (remote && validCkpt(remote)) {
        net = netFromObj(remote); games = remote.games || 0; iter = remote.iter || 0;
        log("resuming: " + games.toLocaleString() + " games trained (iter " + iter + ")");
      } else if (remote) {                                // a net exists but doesn't match this build — a reset must be deliberate
        log("remote net is a different architecture (nIn " + remote.nIn + " ≠ " + INPUT_DIM + ")");
        if (!DRY) { console.error("az_contribute: refusing to start — the cloud net doesn't match this build. Reset the `net` branch deliberately before contributing."); process.exit(1); }
        log("dry run — training a throwaway local net (won't push)");
      } else {
        log("no net on GitHub yet — starting fresh (will create it)");   // genuine 404: nothing to overwrite
      }
    }
  }
  // local checkpoint ahead of the cloud (trained but not yet pushed) wins
  if (localOk && (local.games || 0) > games) {
    net = netFromObj(local); iter = local.iter || 0; games = local.games || 0;
    log("resuming from LOCAL checkpoint: " + games.toLocaleString() + " games (iter " + iter + ") @ " + LOCAL);
  }

  if (!net) { net = freshNet(HIDDEN); iter = 0; games = 0; log("fresh net (hidden " + JSON.stringify(HIDDEN) + ", INPUT_DIM " + INPUT_DIM + ")"); }
  }   // end learner resume

  // spawn the self-play worker pool (one per core by default), kept alive across rounds.
  // split CHUNK across workers so every ROUND is exactly CHUNK games — no rounding drift.
  const base = Math.floor(CHUNK / WORKERS), rem = CHUNK % WORKERS;
  const perWorkerCounts = Array.from({ length: WORKERS }, (_, w) => base + (w < rem ? 1 : 0));
  const perRound = CHUNK;
  const stopFlag = new Int32Array(new SharedArrayBuffer(4));   // shared with workers; set on wind-down to stop after the in-progress game
  const workers = [];
  for (let w = 0; w < WORKERS; w++) {
    const wk = new Worker(__filename, { workerData: { sims: SIMS, cpuct: CPUCT, stop: stopFlag, seed: ((Date.now() ^ (w * 2654435761) ^ (process.pid << 8)) >>> 0) } });
    wk.on("error", (e) => { console.error(`[worker ${w}] ${e.stack || e.message}`); process.exit(1); });
    workers.push(wk);
  }
  const playRound = (netObj) => Promise.all(workers.map((wk, w) => new Promise((resolve) => {
    wk.once("message", (m) => resolve(m));
    wk.postMessage({ net: netObj, games: perWorkerCounts[w] });
  })));

  log((DRY ? "[DRY] " : "") + WORKERS + " workers · " + perRound + " games/round · " + SIMS + " sims" +
    (ACTOR ? " · ACTOR → shards ≤" + SHARD_MAX + "/upload" : " · replay buffer " + BUF_CAP.toLocaleString() + " · push every " + PUSH_EVERY.toLocaleString() + " games" + (sync ? " · draining bus" : "")));
  let stop = false;
  process.on("SIGINT", () => { if (stop) process.exit(1); stop = true; Atomics.store(stopFlag, 0, 1); log("winding down — finishing the in-progress game, then stopping…"); });

  if (ACTOR) {   // ===== ACTOR loop: self-play -> upload shards -> refresh the net when the learner advances it =====
    let uploaded = 0; const ta = Date.now();
    while (!stop) {
      const batches = await playRound(netToObj(net, iter));
      let samples = [], played = 0; for (const b of batches) { samples = samples.concat(b.samples); played += b.played; }
      if (played > 0) {
        let ok = 0;
        if (!DRY) for (let i = 0; i < samples.length; i += SHARD_MAX) { try { await sync.putShard(samples.slice(i, i + SHARD_MAX)); ok++; } catch (e) { log("shard upload failed: " + e.message); } }
        uploaded += played;
        log((DRY ? "[DRY] " : "") + "uploaded " + played + " games (" + samples.length + " samples, " + ok + " shards) · " + uploaded.toLocaleString() + " total" + (stop ? " (wound down)" : ""));
      }
      try { const info = await pullInfo(); if (info && (info.iter || 0) > iter) { const r = await pullNet(); if (r && validCkpt(r)) { net = netFromObj(r); iter = info.iter; log("refreshed to net iter " + iter + " (" + (info.games || 0).toLocaleString() + " games)"); } } } catch (e) {}
    }
    await Promise.all(workers.map((wk) => wk.terminate()));
    log("stopped — uploaded " + uploaded.toLocaleString() + " games this run (" + ((Date.now() - ta) / 1000).toFixed(0) + "s)");
    process.exit(0);
  }

  const buf = [];          // replay buffer: bounded sliding window of recent samples (constant memory, not the whole run)
  let pushAccum = 0;       // games since the last GitHub push
  const t0 = Date.now();
  while (!stop) {
    const it0 = Date.now();
    const batches = await playRound(netToObj(net, iter));   // workers self-play CHUNK games against this snapshot
    let newData = [], played = 0; for (const b of batches) { newData = newData.concat(b.samples); played += b.played; }   // played < CHUNK on wind-down
    if (played > 0) {
      for (const d of newData) buf.push(d);                 // local self-play into the replay buffer
      let remoteSamples = 0, remoteIds = [];                // + drain the actors' shards from the bus into the SAME buffer
      if (sync) { try { const r = await sync.getShards(BUS_LIMIT); for (const sh of r.shards) { for (const d of sh.samples) buf.push(d); remoteSamples += sh.samples.length; remoteIds.push(sh.id); } } catch (e) { log("bus drain failed: " + e.message); } }
      if (buf.length > BUF_CAP) buf.splice(0, buf.length - BUF_CAP);   // evict oldest beyond the cap
      const newSamples = newData.length + remoteSamples;
      const steps = Math.max(1, Math.round(TRAIN_PER_SAMPLE * newSamples / BATCH));
      const loss = trainReplay(net, buf, steps, BATCH, LR, rng);   // shuffled mini-batches sampled from the whole buffer
      const remoteGames = remoteSamples ? Math.round(remoteSamples / Math.max(1, newData.length / Math.max(1, played))) : 0;   // estimate via local samples-per-game
      iter++; games += played + remoteGames; pushAccum += played + remoteGames;
      const gps = (played / ((Date.now() - it0) / 1000)).toFixed(1);
      log("iter " + iter + " (" + games.toLocaleString() + " games): +" + newSamples + " samples (" + newData.length + " local" + (remoteSamples ? " + " + remoteSamples + " bus/" + remoteIds.length + "sh" : "") + "), buf " + buf.length.toLocaleString() + ", " + steps + " steps, loss " + loss.toFixed(3) + " · " + gps + " g/s" + (stop ? " (wound down)" : ""));
      try { writeAtomic(LOCAL, JSON.stringify(ckpt(net, iter, games))); } catch (e) { log("local checkpoint save failed: " + e.message); }   // crash-safety; no network
      if (sync && remoteIds.length) { try { await sync.prune(remoteIds); } catch (e) { log("bus prune failed: " + e.message); } }   // delete consumed shards AFTER ingesting
      if (!stop && !DRY && TOKEN && pushAccum >= PUSH_EVERY) {   // push every PUSH_EVERY games (the wind-down push is below)
        try { await pushNet(net, iter, games); log("pushed " + games.toLocaleString() + " games (iter " + iter + ")"); pushAccum = 0; } catch (e) { log("push failed: " + e.message); }
      }
    }
    // the while(!stop) condition exits after a wind-down (partial) round; the final push happens below.
  }
  await Promise.all(workers.map((wk) => wk.terminate()));
  if (!DRY && TOKEN) { try { await pushNet(net, iter, games); log("wind-down push: iter " + iter + " (" + games.toLocaleString() + " games)"); } catch (e) { log("wind-down push failed: " + e.message); } }
  log("stopped @ iter " + iter + " (" + games.toLocaleString() + " games, " + ((Date.now() - t0) / 1000).toFixed(0) + "s this run)");
  process.exit(0);
})().catch((e) => { console.error("az_contribute:", e.stack || e.message); process.exit(1); });
