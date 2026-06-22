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
 * SINGLE-WRITER: the net is one blob and the push is a force-push, so run only ONE trainer at a time
 * (this OR the phone, not both) — concurrent trainers overwrite each other's games.
 *
 * Usage:
  CZ_TOKEN=<github-pat> node engine/az_contribute.js [gamesPerIter=10000] [sims=40]
 *   Pushes the net to GitHub after each FULL iter (default 10000 games) and once on wind-down (Ctrl-C).
 *   Also writes a local checkpoint every round (no network) for crash safety, and on resume checks the small
 *   info file FIRST (cloud games count) so it only downloads the multi-MB net when the cloud is actually newer.
 * Env:
 *   CZ_TOKEN    GitHub PAT with Contents:read+write on the repo (required, unless --dry)
 *   CZ_REPO     target repo (default "ghug/cribbage-zero")
 *   CZ_WORKERS  self-play worker threads (default: CPU cores − 1)
 *   CZ_CKPT     local checkpoint path (default: engine/az_contribute_ckpt.json)
 * Flags:
 *   --dry       train but never push (pull + self-play + train only — safe smoke test)
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
const { makeRng, selfPlay, train, freshNet, netToObj, netFromObj, writeAtomic, INPUT_DIM } = require("./az_common.js");

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
const HIDDEN = [256, 256, 256, 256], EPOCHS = 2, LR = 0.02, CPUCT = 1.5;   // self-play only — no strength-vs-random eval
const GAMES = parseInt(process.argv[2], 10) || 10000;
const SIMS = parseInt(process.argv[3], 10) || 40;
const WORKERS = Math.max(1, parseInt(process.env.CZ_WORKERS, 10) || (os.cpus().length - 1));
const DRY = process.argv.includes("--dry");
const REPO = process.env.CZ_REPO || "ghug/cribbage-zero";
const TOKEN = process.env.CZ_TOKEN || "";
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
async function pullNet() {   // RAW media type — the net is multi-MB and the JSON repr only inlines content ≤1MB
  const res = await fetch("https://api.github.com/repos/" + REPO + "/contents/" + encodeURIComponent(CKPATH) + "?ref=" + BRANCH, {
    headers: { Authorization: "Bearer " + TOKEN, Accept: "application/vnd.github.raw", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cribbage-zero-contribute" },
  });
  if (res.status === 404) return null;
  if (res.status >= 400) throw new Error("pull net -> " + res.status);
  return JSON.parse(await res.text());
}
// small "is the cloud net newer?" probe — read FIRST so we don't pull the multi-MB net unless we must.
async function pullInfo() {   // {games, iter} or null if the info file doesn't exist yet
  const res = await fetch("https://api.github.com/repos/" + REPO + "/contents/" + encodeURIComponent(INFOPATH) + "?ref=" + BRANCH, {
    headers: { Authorization: "Bearer " + TOKEN, Accept: "application/vnd.github.raw", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cribbage-zero-contribute" },
  });
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

(async () => {
  let net, iter = 0, games = 0;

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

  // spawn the self-play worker pool (one per core by default), kept alive across rounds.
  // split GAMES across workers so every ROUND is exactly GAMES — no rounding drift (e.g. 500, not 495).
  const base = Math.floor(GAMES / WORKERS), rem = GAMES % WORKERS;
  const perWorkerCounts = Array.from({ length: WORKERS }, (_, w) => base + (w < rem ? 1 : 0));
  const perRound = GAMES;
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

  log((DRY ? "[DRY] " : "") + WORKERS + " workers · " + perRound + " games/round · " + SIMS + " sims · pushes only on wind-down (Ctrl-C)");
  let stop = false;
  process.on("SIGINT", () => { if (stop) process.exit(1); stop = true; Atomics.store(stopFlag, 0, 1); log("winding down — finishing the in-progress game, then pushing…"); });

  const t0 = Date.now();
  while (!stop) {
    const it0 = Date.now();
    const batches = await playRound(netToObj(net, iter));   // workers self-play against this snapshot, in parallel
    let data = [], played = 0; for (const b of batches) { data = data.concat(b.samples); played += b.played; }   // played < round on wind-down
    if (played > 0) {
      const loss = train(net, data, EPOCHS, LR, rng);
      iter++; games += played;
      const gps = (played / ((Date.now() - it0) / 1000)).toFixed(1);
      log("iter " + iter + " (" + games.toLocaleString() + " games): " + data.length + " samples, loss " + loss.toFixed(3) + " · " + gps + " games/s" + (stop ? " (wound down)" : ""));
      try { writeAtomic(LOCAL, JSON.stringify(ckpt(net, iter, games))); } catch (e) { log("local checkpoint save failed: " + e.message); }   // crash-safety; no network
      if (!stop && !DRY && TOKEN) {                        // auto-push after each FULL iter; the wind-down (partial) iter is pushed once below
        try { await pushNet(net, iter, games); log("pushed iter " + iter + " (" + games.toLocaleString() + " games)"); } catch (e) { log("push failed: " + e.message); }
      }
    }
    // the while(!stop) condition exits after a wind-down (partial) round; the final push happens below.
  }
  await Promise.all(workers.map((wk) => wk.terminate()));
  if (!DRY && TOKEN) { try { await pushNet(net, iter, games); log("wind-down push: iter " + iter + " (" + games.toLocaleString() + " games)"); } catch (e) { log("wind-down push failed: " + e.message); } }
  log("stopped @ iter " + iter + " (" + games.toLocaleString() + " games, " + ((Date.now() - t0) / 1000).toFixed(0) + "s this run)");
  process.exit(0);
})().catch((e) => { console.error("az_contribute:", e.stack || e.message); process.exit(1); });
