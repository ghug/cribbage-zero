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
 *   CZ_TOKEN=<github-pat> node engine/az_contribute.js [gamesPerIter=500] [sims=50] [pushEvery=5]
 * Env:
 *   CZ_TOKEN    GitHub PAT with Contents:read+write on the repo (required, unless --dry)
 *   CZ_REPO     target repo (default "ghug/cribbage-zero")
 *   CZ_WORKERS  self-play worker threads (default: CPU cores − 1)
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
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const { makeRng, selfPlay, train, freshNet, netToObj, netFromObj, INPUT_DIM } = require("./az_common.js");

/* ---------------- WORKER: self-play against a net snapshot, hand samples back ---------------- */
if (!isMainThread) {
  const rng = makeRng((workerData.seed ^ (Date.now() & 0xffff)) >>> 0);
  let net = null;
  parentPort.on("message", (msg) => {
    if (msg.stop) { process.exit(0); }
    if (msg.net) net = netFromObj(msg.net);
    let data = [];
    for (let g = 0; g < msg.games; g++) data = data.concat(selfPlay(net, workerData.sims, workerData.cpuct, rng));
    parentPort.postMessage({ samples: data });   // {x,pi,legal,z} — plain arrays, structured-cloned back
  });
  return;
}

/* ---------------- MAIN (learner): pull net, fan self-play across workers, train, push ---------------- */
const HID = 64, EPOCHS = 2, LR = 0.02, CPUCT = 1.5;   // self-play only — no strength-vs-random eval
const GAMES = parseInt(process.argv[2], 10) || 500;
const SIMS = parseInt(process.argv[3], 10) || 50;
const PUSH_EVERY = parseInt(process.argv[4], 10) || 5;
const WORKERS = Math.max(1, parseInt(process.env.CZ_WORKERS, 10) || (os.cpus().length - 1));
const DRY = process.argv.includes("--dry");
const REPO = process.env.CZ_REPO || "ghug/cribbage-zero";
const TOKEN = process.env.CZ_TOKEN || "";
const BRANCH = "net", CKPATH = "checkpoints/az_checkpoint.json";
const rng = makeRng((Date.now() ^ (process.pid << 8)) >>> 0);
const now = () => new Date().toLocaleTimeString();
const log = (m) => console.log(`[${now()}] ${m}`);

if (!TOKEN && !DRY) { console.error("az_contribute: set CZ_TOKEN (a GitHub PAT) or pass --dry"); process.exit(1); }

// --- the net file is WEIGHTS + iter + games (the net's training position) ---
function ckpt(net, iter, games) { const o = netToObj(net, iter); o.games = games; return o; }   // {iter,games,nIn,nHid,nPol,W1,...}
function validCkpt(o) {
  return o && o.nHid === HID && Array.isArray(o.W1) && o.W1.length === o.nHid && Array.isArray(o.W1[0]) &&
    o.W1[0].length === o.nIn && o.nIn === INPUT_DIM && Array.isArray(o.b1) && Array.isArray(o.Wv) &&
    Array.isArray(o.Wp) && Array.isArray(o.bp);
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
async function pullNet() {
  try { const r = await gh("GET", "/repos/" + REPO + "/contents/" + encodeURIComponent(CKPATH) + "?ref=" + BRANCH);
    return JSON.parse(unb64(r.body.content)); }
  catch (e) { if (/-> 404/.test(e.message)) return null; throw e; }
}
async function pushNet(net, iter, games) {   // pushes ONLY the net file; progress.csv is on its own branch, untouched
  const netBlob = await gh("POST", "/repos/" + REPO + "/git/blobs", { content: b64(JSON.stringify(ckpt(net, iter, games))), encoding: "base64" });
  const tree = await gh("POST", "/repos/" + REPO + "/git/trees", { tree: [
    { path: CKPATH, mode: "100644", type: "blob", sha: netBlob.body.sha },
  ] });
  const commit = await gh("POST", "/repos/" + REPO + "/git/commits", { message: "net @ iter " + iter + " (" + games + " games)", tree: tree.body.sha, parents: [] });
  let ref; try { ref = await gh("GET", "/repos/" + REPO + "/git/ref/heads/" + BRANCH); } catch (e) { ref = { status: 404 }; }
  if (ref.status === 200) await gh("PATCH", "/repos/" + REPO + "/git/refs/heads/" + BRANCH, { sha: commit.body.sha, force: true });
  else await gh("POST", "/repos/" + REPO + "/git/refs", { ref: "refs/heads/" + BRANCH, sha: commit.body.sha });
}

(async () => {
  let net, iter = 0, games = 0;
  if (TOKEN) {
    log("pulling net from " + REPO + " @ " + BRANCH + " …");
    let remote, pullErr = null;
    try { remote = await pullNet(); } catch (e) { pullErr = e; }   // pullNet returns null on a clean 404, throws otherwise
    if (pullErr) {                                        // couldn't READ the cloud net — refuse, so we never overwrite it blind
      log("pull failed: " + pullErr.message);
      if (!DRY) { console.error("az_contribute: refusing to start — can't read the cloud net, and training would push a net that overwrites it. Fix the token/connection and retry."); process.exit(1); }
      log("dry run — training a throwaway local net (won't push)");
    } else if (remote && validCkpt(remote)) {
      net = netFromObj(remote);
      games = remote.games || 0; iter = remote.iter || 0;   // games/iter live in the net file
      log("resuming: " + games.toLocaleString() + " games trained (iter " + iter + ")");
    } else if (remote) {                                 // a net exists but doesn't match this build — a reset must be deliberate, not automatic
      log("remote net is a different architecture (nIn " + remote.nIn + " ≠ " + INPUT_DIM + ")");
      if (!DRY) { console.error("az_contribute: refusing to start — the cloud net doesn't match this build. Reset the `net` branch deliberately before contributing."); process.exit(1); }
      log("dry run — training a throwaway local net (won't push)");
    } else {
      log("no net on GitHub yet — starting fresh (will create it)");   // genuine 404: nothing to overwrite
    }
  }
  if (!net) { net = freshNet(HID); iter = 0; games = 0; log("fresh net (hidden " + HID + ", INPUT_DIM " + INPUT_DIM + ")"); }

  // spawn the self-play worker pool (one per core by default), kept alive across rounds
  const perWorker = Math.max(1, Math.round(GAMES / WORKERS)), perRound = perWorker * WORKERS;
  const workers = [];
  for (let w = 0; w < WORKERS; w++) {
    const wk = new Worker(__filename, { workerData: { sims: SIMS, cpuct: CPUCT, seed: ((Date.now() ^ (w * 2654435761) ^ (process.pid << 8)) >>> 0) } });
    wk.on("error", (e) => { console.error(`[worker ${w}] ${e.stack || e.message}`); process.exit(1); });
    workers.push(wk);
  }
  const playRound = (netObj) => Promise.all(workers.map((wk) => new Promise((resolve) => {
    wk.once("message", (m) => resolve(m.samples));
    wk.postMessage({ net: netObj, games: perWorker });
  })));

  log((DRY ? "[DRY] " : "") + WORKERS + " workers × " + perWorker + " games = " + perRound + "/round · " + SIMS + " sims, push every " + PUSH_EVERY + " rounds");
  let stop = false;
  process.on("SIGINT", () => { if (stop) process.exit(1); stop = true; log("stopping after this round…"); });

  const t0 = Date.now();
  while (!stop) {
    const it0 = Date.now();
    const batches = await playRound(netToObj(net, iter));   // workers self-play against this snapshot, in parallel
    if (stop) break;
    let data = []; for (const b of batches) data = data.concat(b);
    const loss = train(net, data, EPOCHS, LR, rng);
    iter++; games += perRound;
    const gps = (perRound / ((Date.now() - it0) / 1000)).toFixed(1);
    log("iter " + iter + " (" + games.toLocaleString() + " games): " + data.length + " samples, loss " + loss.toFixed(3) + " · " + gps + " games/s");
    if (!DRY && TOKEN && iter % PUSH_EVERY === 0) {
      try { await pushNet(net, iter, games); log("pushed net iter " + iter + " (" + games.toLocaleString() + " games)"); }
      catch (e) { log("push failed: " + e.message); }
    }
  }
  await Promise.all(workers.map((wk) => wk.terminate()));
  if (!DRY && TOKEN) { try { await pushNet(net, iter, games); log("final push: iter " + iter + " (" + games.toLocaleString() + " games)"); } catch (e) { log("final push failed: " + e.message); } }
  log("stopped @ iter " + iter + " (" + games.toLocaleString() + " games, " + ((Date.now() - t0) / 1000).toFixed(0) + "s this run)");
  process.exit(0);
})().catch((e) => { console.error("az_contribute:", e.stack || e.message); process.exit(1); });
