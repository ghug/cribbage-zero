#!/usr/bin/env node
/* engine/az_trainer.js — the single TRAINER for parallel Cribbage Zero training.
 *
 * The one writer of the checkpoint: it consumes self-play shards produced by the workers
 * (engine/az_data/*.json), SGD-trains the net on them, republishes engine/az_checkpoint.json
 * (atomically), and deletes the consumed shards. Resumes from an existing checkpoint, or seeds a
 * fresh random net (tabula rasa) if none exists. Runs until no new shards arrive for `idle` ms.
 *
 * Local mode : node engine/az_trainer.js [hidden=48] [idleSec=20] [--eval]
 * Remote mode: ... --remote [--once]   consume shards from the data-bus Worker API, train, publish the
 *              checkpoint, prune. Needs env AZ_API_URL + AZ_TRAINER_TOKEN. `--once` drains the queue once
 *              and exits (for the scheduled GitHub Action); without it, it polls until idle.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { freshNet, loadCheckpoint, saveCheckpoint, train, evalVsRandom, makeRng, netFromObj, netToObj } = require("./az_common.js");

const HID = parseInt(process.argv[2], 10) || 48;
const IDLE = (parseInt(process.argv[3], 10) || 20) * 1000;
const DO_EVAL = process.argv.includes("--eval");
const REMOTE = process.argv.includes("--remote");
const ONCE = process.argv.includes("--once");
const SEED = (() => { const i = process.argv.indexOf("--seed"); return i >= 0 ? process.argv[i + 1] : null; })();   // initial net for an empty D1
const LR = 0.02, EPOCHS = 2, EVAL = 200, EVAL_EVERY = 20, LIMIT = 10;   // pull few shards/call (shards are larger now); loop drains
const CKPT = path.join(__dirname, "az_checkpoint.json");
const DATA = path.join(__dirname, "az_data");
const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {} };
const sleepP = (ms) => new Promise((r) => setTimeout(r, ms));
const rng = makeRng((Date.now() ^ 0x1234) >>> 0);

if (REMOTE) {
  const { makeSync } = require("./az_sync.js");
  const apiUrl = process.env.AZ_API_URL, token = process.env.AZ_TRAINER_TOKEN;
  if (!apiUrl || !token) { console.error("[trainer] --remote needs env AZ_API_URL and AZ_TRAINER_TOKEN"); process.exit(1); }
  const sync = makeSync({ apiUrl, token, workerId: "trainer" });
  (async () => {
    let net, iter;
    const cur = await sync.getCheckpoint();
    if (cur && cur.net) { net = netFromObj(cur.net); iter = cur.iter; console.log(`[trainer] resuming @ iter ${iter} (hidden ${net.nHid})`); }
    else if (SEED && fs.existsSync(SEED)) {
      const seed = JSON.parse(fs.readFileSync(SEED, "utf8"));
      net = netFromObj(seed); iter = seed.iter || 0;
      await sync.putCheckpoint(netToObj(net, iter));
      console.log(`[trainer] seeded D1 from ${SEED} @ iter ${iter} (hidden ${net.nHid}) — continuing prior training`);
    } else { net = freshNet(HID); iter = 0; await sync.putCheckpoint(netToObj(net, iter)); console.log(`[trainer] seeded fresh net (hidden ${HID})`); }
    const t0 = Date.now(); let lastData = Date.now(), consumed = 0;
    for (;;) {
      const { shards } = await sync.getShards(LIMIT);
      if (!shards || shards.length === 0) {
        if (ONCE || Date.now() - lastData > IDLE) break;
        await sleepP(2000); continue;
      }
      let data = []; for (const s of shards) data = data.concat(s.samples);
      const loss = train(net, data, EPOCHS, LR, rng);
      iter += 1; consumed += shards.length;
      await sync.putCheckpoint(netToObj(net, iter));
      await sync.prune(shards.map((s) => s.id));
      lastData = Date.now();
      let line = `[trainer] iter ${iter}: ${shards.length} shards / ${data.length} samples, loss ${loss.toFixed(3)} [${((Date.now() - t0) / 1000).toFixed(0)}s]`;
      if (DO_EVAL && iter % EVAL_EVERY === 0) line += `  vs random ${(100 * evalVsRandom(net, EVAL, rng)).toFixed(1)}%`;
      console.log(line);
      if (ONCE && data.length === 0) break;
    }
    console.log(`[trainer] stopping @ iter ${iter} (${consumed} shards consumed this run)`);
  })().catch((e) => { console.error("[trainer]", e.message); process.exit(1); });
  return;
}

fs.mkdirSync(DATA, { recursive: true });
let ck = loadCheckpoint(CKPT), net, iter;
if (ck) { net = ck.net; iter = ck.iter; console.log(`[trainer] resuming @ iter ${iter} (hidden ${net.nHid})`); }
else { net = freshNet(HID); iter = 0; saveCheckpoint(CKPT, net, iter); console.log(`[trainer] fresh net (hidden ${HID}), initial checkpoint written`); }

const t0 = Date.now(); let lastData = Date.now(), consumed = 0;
for (;;) {
  const shards = fs.readdirSync(DATA).filter((f) => f.endsWith(".json"));
  if (shards.length === 0) {
    if (Date.now() - lastData > IDLE) break;
    sleep(500); continue;
  }
  let data = [];
  for (const f of shards) { const p = path.join(DATA, f); try { data = data.concat(JSON.parse(fs.readFileSync(p, "utf8"))); } catch (e) {} fs.unlinkSync(p); }
  const loss = train(net, data, EPOCHS, LR, rng);
  iter += 1; consumed += shards.length;
  saveCheckpoint(CKPT, net, iter);
  lastData = Date.now();
  let line = `[trainer] iter ${iter}: trained on ${shards.length} shards / ${data.length} samples, loss ${loss.toFixed(3)} [${((Date.now() - t0) / 1000).toFixed(0)}s]`;
  if (DO_EVAL && iter % EVAL_EVERY === 0) line += `  vs random ${(100 * evalVsRandom(net, EVAL, rng)).toFixed(1)}%`;
  console.log(line);
}
console.log(`[trainer] idle ${IDLE / 1000}s with no shards — stopping @ iter ${iter} (${consumed} shards consumed total)`);
