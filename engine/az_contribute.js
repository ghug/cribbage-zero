#!/usr/bin/env node
/* engine/az_contribute.js — contribute self-play from a COMPUTER to the shared net.
 *
 * A headless Node port of local.html's trainer: it pulls the net from the GitHub `net` branch, runs
 * self-play + SGD (reusing the same engine the phone does), and force-pushes the improved net back —
 * so a PC can carry the same training the phone does, just much faster. The checkpoint format is
 * identical (netToObj + {games, graph}), so the phone and this script are interchangeable: each
 * resumes from whatever the other last pushed.
 *
 * SINGLE-WRITER: the net is one blob and the push is a force-push, so run only ONE trainer at a time
 * (this OR the phone, not both at once) — concurrent trainers overwrite each other's games. A PC so
 * outpaces a phone that you'd typically just let this drive and leave the phone off.
 *
 * Usage:
 *   CZ_TOKEN=<github-pat> node engine/az_contribute.js [gamesPerIter=500] [sims=50] [pushEvery=5] [graphEvery=10000]
 * Env:
 *   CZ_TOKEN  GitHub PAT with Contents:read+write on the repo (required, unless --dry)
 *   CZ_REPO   target repo (default "ghug/cribbage-zero")
 * Flags:
 *   --dry     train but never push (pull + self-play + train only — safe for a smoke test)
 *   --fresh   ignore the remote net and start from a fresh tabula-rasa net
 *
 * Ctrl-C does a final push, then exits.
 */
"use strict";
const { makeRng, selfPlay, train, evalVsRandom, freshNet, netToObj, netFromObj, INPUT_DIM } = require("./az_common.js");

const HID = 64, EPOCHS = 2, LR = 0.02, CPUCT = 1.5, EVAL = 100, EVAL_EVERY = 5;   // match local.html
const GAMES = parseInt(process.argv[2], 10) || 500;
const SIMS = parseInt(process.argv[3], 10) || 50;
const PUSH_EVERY = parseInt(process.argv[4], 10) || 5;
const GRAPH_EVERY = parseInt(process.argv[5], 10) || 10000;
const DRY = process.argv.includes("--dry");
const FRESH = process.argv.includes("--fresh");
const REPO = process.env.CZ_REPO || "ghug/cribbage-zero";
const TOKEN = process.env.CZ_TOKEN || "";
const BRANCH = "net", CKPATH = "checkpoints/az_checkpoint.json", PROGPATH = "checkpoints/progress.json";
const rng = makeRng((Date.now() ^ (process.pid << 8)) >>> 0);
const now = () => new Date().toLocaleTimeString();
const log = (m) => console.log(`[${now()}] ${m}`);

if (!TOKEN && !DRY) { console.error("az_contribute: set CZ_TOKEN (a GitHub PAT) or pass --dry"); process.exit(1); }

// --- checkpoint shape (identical to local.html's ckObj) + validity guard ---
function ckObj(net, iter, games, graph) { const o = netToObj(net, iter); o.games = games; o.graph = graph; return o; }
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
async function pushNet(net, iter, games, graph) {
  const netBlob = await gh("POST", "/repos/" + REPO + "/git/blobs", { content: b64(JSON.stringify(ckObj(net, iter, games, graph))), encoding: "base64" });
  const prog = { updated: new Date().toISOString(), games, iter, points: graph.map((pt) => ({ games: pt.g, vsRandomPct: pt.p })) };
  const progBlob = await gh("POST", "/repos/" + REPO + "/git/blobs", { content: b64(JSON.stringify(prog, null, 1)), encoding: "base64" });
  const tree = await gh("POST", "/repos/" + REPO + "/git/trees", { tree: [
    { path: CKPATH, mode: "100644", type: "blob", sha: netBlob.body.sha },
    { path: PROGPATH, mode: "100644", type: "blob", sha: progBlob.body.sha },
  ] });
  const commit = await gh("POST", "/repos/" + REPO + "/git/commits", { message: "net @ iter " + iter + " (" + games + " games)", tree: tree.body.sha, parents: [] });
  let ref; try { ref = await gh("GET", "/repos/" + REPO + "/git/ref/heads/" + BRANCH); } catch (e) { ref = { status: 404 }; }
  if (ref.status === 200) await gh("PATCH", "/repos/" + REPO + "/git/refs/heads/" + BRANCH, { sha: commit.body.sha, force: true });
  else await gh("POST", "/repos/" + REPO + "/git/refs", { ref: "refs/heads/" + BRANCH, sha: commit.body.sha });
}

(async () => {
  let net, iter = 0, games = 0, graph = [];
  if (!FRESH && TOKEN) {
    log("pulling net from " + REPO + " @ " + BRANCH + " …");
    let remote = null; try { remote = await pullNet(); } catch (e) { log("pull failed: " + e.message); }
    if (remote && validCkpt(remote)) { net = netFromObj(remote); iter = remote.iter || 0; games = remote.games || 0; graph = Array.isArray(remote.graph) ? remote.graph : []; log("resuming: " + games.toLocaleString() + " games trained (iter " + iter + ")"); }
    else if (remote) { log("remote net is a different architecture (nIn " + remote.nIn + " ≠ " + INPUT_DIM + ") — starting fresh"); }
    else log("no net on GitHub yet — starting fresh");
  }
  if (!net) { net = freshNet(HID); iter = 0; games = 0; graph = []; log("fresh net (hidden " + HID + ", INPUT_DIM " + INPUT_DIM + ")"); }

  log((DRY ? "[DRY] " : "") + GAMES + " games/iter × " + SIMS + " sims, push every " + PUSH_EVERY + " iters, graph every " + GRAPH_EVERY.toLocaleString() + " games");
  let stop = false, pushing = Promise.resolve();
  process.on("SIGINT", () => { if (stop) process.exit(1); stop = true; log("stopping after this iteration…"); });

  const t0 = Date.now();
  while (!stop) {
    const it0 = Date.now();
    let data = [];
    for (let g = 0; g < GAMES && !stop; g++) data = data.concat(selfPlay(net, SIMS, CPUCT, rng));
    if (stop && data.length === 0) break;
    const loss = train(net, data, EPOCHS, LR, rng);
    iter++; games += GAMES;
    const gps = (GAMES / ((Date.now() - it0) / 1000)).toFixed(1);
    log("iter " + iter + " (" + games.toLocaleString() + " games): " + data.length + " samples, loss " + loss.toFixed(3) + " · " + gps + " games/s");
    if (iter % EVAL_EVERY === 0) log("vs random: " + (100 * evalVsRandom(net, EVAL, rng)).toFixed(1) + "%");
    const lastG = graph.length ? graph[graph.length - 1].g : 0;
    if (games - lastG >= GRAPH_EVERY) { const pct = +(100 * evalVsRandom(net, EVAL, rng)).toFixed(1); graph.push({ g: games, p: pct }); log("★ graph: " + pct + "% vs random @ " + games.toLocaleString() + " games"); }
    if (!DRY && TOKEN && iter % PUSH_EVERY === 0) {
      try { await pushNet(net, iter, games, graph); log("pushed net iter " + iter + " (" + games.toLocaleString() + " games)"); }
      catch (e) { log("push failed: " + e.message); }
    }
  }
  if (!DRY && TOKEN) { try { await pushNet(net, iter, games, graph); log("final push: iter " + iter + " (" + games.toLocaleString() + " games)"); } catch (e) { log("final push failed: " + e.message); } }
  log("stopped @ iter " + iter + " (" + games.toLocaleString() + " games, " + ((Date.now() - t0) / 1000).toFixed(0) + "s this run)");
  process.exit(0);
})().catch((e) => { console.error("az_contribute:", e.stack || e.message); process.exit(1); });
