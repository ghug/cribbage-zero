#!/usr/bin/env node
/* engine/az_parallel.js — one-box orchestrator for parallel Cribbage Zero training.
 *
 * Forks the single trainer + N self-play workers so a local machine saturates its cores: workers
 * generate self-play shards in parallel against the latest checkpoint, the trainer consumes them and
 * republishes the net. Resumes from engine/az_checkpoint.json (use --fresh to restart). Each worker
 * does `chunk` batches then exits; when all workers are done the trainer drains the last shards and
 * stops on idle.
 *
 * For MULTI-MACHINE / multi-agent: skip this and run `node engine/az_trainer.js` on one box and
 * `node engine/az_worker.js <id> 60` on each other, all sharing engine/az_data + the checkpoint
 * (e.g. a shared dir, or sync the shards/checkpoint via git between agents).
 *
 * Run: node engine/az_parallel.js [workers=4] [chunk=60] [games=20] [sims=40] [--fresh] [--eval]
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const N = parseInt(process.argv[2], 10) || 4;
const CHUNK = parseInt(process.argv[3], 10) || 60;
const GAMES = parseInt(process.argv[4], 10) || 20;
const SIMS = parseInt(process.argv[5], 10) || 40;
const FRESH = process.argv.includes("--fresh");
const EVAL = process.argv.includes("--eval");
const CKPT = path.join(__dirname, "az_checkpoint.json");
if (FRESH && fs.existsSync(CKPT)) fs.unlinkSync(CKPT);

const node = process.execPath;
const run = (args) => spawn(node, args.map(String), { stdio: "inherit" });
const onExit = (p) => new Promise((res) => p.on("exit", res));

console.log(`[orchestrator] ${N} workers × ${CHUNK} batches × ${GAMES} games × ${SIMS} sims  (trainer + workers)`);
const trainerArgs = [path.join(__dirname, "az_trainer.js"), 48, 20]; if (EVAL) trainerArgs.push("--eval");
const trainer = run(trainerArgs);

// give the trainer a moment to write the initial checkpoint, then launch workers
setTimeout(() => {
  const workers = [];
  for (let i = 0; i < N; i++) workers.push(run([path.join(__dirname, "az_worker.js"), i, CHUNK, GAMES, SIMS]));
  Promise.all(workers.map(onExit)).then(() => {
    console.log(`[orchestrator] all ${N} workers finished their chunk; trainer will drain + stop on idle`);
  });
}, 1500);

onExit(trainer).then((code) => { console.log(`[orchestrator] trainer exited (${code}); run complete`); process.exit(0); });
