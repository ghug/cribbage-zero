#!/usr/bin/env node
/* engine/az_worker.js — a self-play WORKER for parallel Cribbage Zero training.
 *
 * Generates self-play games against the latest published checkpoint and drops the labelled samples
 * as shards into engine/az_data/ for the trainer to consume. Stateless and contention-free (each
 * worker only writes its own shard files), so you can run many in parallel — as local processes
 * (one per core) or as separate agents/machines sharing engine/az_data + engine/az_checkpoint.json.
 * Each invocation does CHUNK batches ("picks up 60 iters"), reloading the checkpoint each batch so it
 * always plays the freshest net.
 *
 * Local mode  : node engine/az_worker.js <id> <chunkBatches=60> <gamesPerBatch=20> <sims=40>
 * Remote mode : ... --remote   (push shards to the data-bus Worker API; needs env
 *               AZ_API_URL + AZ_WORKER_TOKEN). Pulls the checkpoint + pushes shards over HTTP.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { makeRng, selfPlay, loadCheckpoint, writeAtomic, netFromObj } = require("./az_common.js");

const ID = parseInt(process.argv[2], 10) || 0;
const CHUNK = parseInt(process.argv[3], 10) || 60;
const GAMES = parseInt(process.argv[4], 10) || 20;
const SIMS = parseInt(process.argv[5], 10) || 40;
const CPUCT = 1.5;
const REMOTE = process.argv.includes("--remote");
const CKPT = path.join(__dirname, "az_checkpoint.json");
const DATA = path.join(__dirname, "az_data");
const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {} };
const sleepP = (ms) => new Promise((r) => setTimeout(r, ms));
const rng = makeRng((Date.now() ^ (ID * 2654435761) ^ (process.pid << 8)) >>> 0);

if (REMOTE) {
  const { makeSync } = require("./az_sync.js");
  const apiUrl = process.env.AZ_API_URL, token = process.env.AZ_WORKER_TOKEN;
  if (!apiUrl || !token) { console.error(`[w${ID}] --remote needs env AZ_API_URL and AZ_WORKER_TOKEN`); process.exit(1); }
  const workerId = `node-${ID}-${process.pid.toString(36)}`;
  const sync = makeSync({ apiUrl, token, workerId });
  (async () => {
    console.log(`[w${ID}] remote worker -> ${apiUrl}: ${CHUNK} batches × ${GAMES} games × ${SIMS} sims`);
    const t0 = Date.now();
    for (let b = 0; b < CHUNK; b++) {
      let ck = await sync.getCheckpoint();
      while (!ck || !ck.net) { console.log(`[w${ID}] waiting for the trainer's first checkpoint…`); await sleepP(3000); ck = await sync.getCheckpoint(); }
      const net = netFromObj(ck.net);
      let samples = [];
      for (let g = 0; g < GAMES; g++) samples = samples.concat(selfPlay(net, SIMS, CPUCT, rng));
      await sync.putShard(samples, workerId);
      if ((b + 1) % 5 === 0) console.log(`[w${ID}] pushed ${b + 1}/${CHUNK} (ckpt iter ${ck.iter}, ${samples.length} samples) [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
    }
    console.log(`[w${ID}] done ${CHUNK} batches [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
  })().catch((e) => { console.error(`[w${ID}]`, e.message); process.exit(1); });
} else {
  fs.mkdirSync(DATA, { recursive: true });
  console.log(`[w${ID}] self-play worker: ${CHUNK} batches × ${GAMES} games × ${SIMS} sims`);
  const t0 = Date.now();
  for (let b = 0; b < CHUNK; b++) {
    let ck = loadCheckpoint(CKPT);
    while (!ck) { sleep(500); ck = loadCheckpoint(CKPT); }     // wait for the trainer's initial checkpoint
    let samples = [];
    for (let g = 0; g < GAMES; g++) samples = samples.concat(selfPlay(ck.net, SIMS, CPUCT, rng));
    writeAtomic(path.join(DATA, `w${ID}-${Date.now()}-${b}.json`), JSON.stringify(samples));
    if ((b + 1) % 10 === 0) console.log(`[w${ID}] batch ${b + 1}/${CHUNK} (ckpt iter ${ck.iter}, ${samples.length} samples) [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
  }
  console.log(`[w${ID}] done ${CHUNK} batches [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
}
