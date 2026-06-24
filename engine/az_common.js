/* engine/az_common.js — shared core for the Cribbage Zero training scripts (single-process and the
 * parallel worker/trainer driver). Self-play generation, the SGD train step, net (de)serialization,
 * and atomic checkpoint/shard I/O. No global state — every randomized routine takes an explicit rng,
 * so parallel workers get independent streams.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { Net } = require("./az_net.js");
const { CribGame } = require("./az_game.js");
const { search } = require("./az_mcts.js");

const NPOL = CribGame.NPOL;
const INPUT_DIM = CribGame.INPUT_DIM;

function makeRng(seed) { let a = (seed | 0) || 1; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function sampleSlot(policy, rng) { let u = rng(), c = 0; for (let s = 0; s < NPOL; s++) { c += policy[s]; if (u <= c) return s; } for (let s = NPOL - 1; s >= 0; s--) if (policy[s] > 0) return s; return 0; }
function argmaxLegal(probs, legal) { let m = -1, b = -Infinity; for (let s = 0; s < NPOL; s++) if (legal[s] && probs[s] > b) { b = probs[s]; m = s; } return m; }
function randomLegal(legal, rng) { const ls = []; for (let s = 0; s < NPOL; s++) if (legal[s]) ls.push(s); return ls[(rng() * ls.length) | 0]; }

// one self-play game → labeled training samples (state, visit-policy π, outcome z=±1)
function selfPlay(net, sims, cPuct, rng) {
  const g = new CribGame(rng), samples = [];
  let guard = 0;
  while (!g.done && guard++ < 4000) {
    const player = g.toAct;
    const { policy } = search(g, net, sims, cPuct, rng);
    samples.push({ x: g.encode(player), pi: policy, legal: g.decision.slots.slice(), player });
    g.step(sampleSlot(policy, rng));
  }
  for (const s of samples) { s.z = s.player === g.winner ? 1 : -1; delete s.player; }
  return samples;
}

function train(net, data, epochs, lr, rng) {
  let loss = 0, n = 0;
  for (let e = 0; e < epochs; e++) {
    for (let i = data.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const t = data[i]; data[i] = data[j]; data[j] = t; }
    for (const d of data) { loss += net.trainStep(d.x, d.z, d.pi, d.legal, lr); n++; }
  }
  return loss / Math.max(1, n);
}

// net (greedy on its raw policy) vs a random player, ANTITHETIC: each deal is played TWICE with the net on
// opposite seats (same deal-RNG seed, independent move-RNG), so deal luck cancels across the pair and the
// win% estimate has far lower variance. `pairs` deals -> 2*pairs games; deal seeds drawn from `rng`.
function evalVsRandom(net, pairs, rng) {
  let wins = 0;
  for (let pi = 0; pi < pairs; pi++) {
    const dealSeed = (rng() * 4294967296) >>> 0;
    for (let half = 0; half < 2; half++) {
      const dealRng = makeRng(dealSeed);                                      // SAME deal both halves
      const moveRng = makeRng((dealSeed ^ (0x9e3779b9 * (half + 1))) >>> 0);  // independent move noise
      const g = new CribGame(dealRng), netSeat = half; let guard = 0;
      while (!g.done && guard++ < 4000) {
        const p = g.toAct, legal = g.decision.slots;
        g.step(p === netSeat ? argmaxLegal(Net.softmax(net.forward(g.encode(p)).logits, legal), legal) : randomLegal(legal, moveRng));
      }
      if (g.winner === netSeat) wins++;
    }
  }
  return wins / (pairs * 2);
}

/* ---- net (de)serialization + atomic checkpoint/shard I/O ---- */
// Format: { iter, nIn, hidden:[...], nHid(last), nPol, W:[...], b:[...], Wv, bv, Wp, bp }. netFromObj also
// reads the legacy single-layer shape (W1/b1) so old archived checkpoints stay loadable.
function netToObj(net, iter) { return { iter, nIn: net.nIn, hidden: net.hidden.slice(), nHid: net.nHid, nPol: net.nPol, W: net.W, b: net.b, Wv: net.Wv, bv: net.bv, Wp: net.Wp, bp: net.bp }; }
// flat row-major (rows*cols) → nested [rows][cols]; an already-nested array passes through unchanged.
function reshapeMat(a, rows, cols) {
  if (!a || a.length === 0 || Array.isArray(a[0])) return a;   // already nested (a JS-trained net)
  const out = new Array(rows);
  for (let i = 0; i < rows; i++) { const row = new Array(cols), base = i * cols; for (let k = 0; k < cols; k++) row[k] = a[base + k]; out[i] = row; }
  return out;
}
function netFromObj(o) {
  const hidden = o.hidden || [o.nHid];
  const n = new Net(o.nIn, hidden, o.nPol);
  // The C++ engine serializes W[l]/Wp FLAT (row-major dout*din, nPol*nHid); JS Net.forward indexes them
  // nested ([dout][din], [nPol][nHid]). Reshape flat → nested on load so the JS engine (eval.html/eval_zero)
  // can run a C++-trained net. JS-trained nets are already nested and pass through. b/Wv/bv/bp are flat in both.
  if (o.W) {
    const sizes = [o.nIn].concat(hidden);
    n.W = o.W.map((layer, l) => reshapeMat(layer, sizes[l + 1], sizes[l]));
    n.b = o.b;
  } else { n.W = [o.W1]; n.b = [o.b1]; }   // legacy single-layer
  n.Wv = o.Wv; n.bv = o.bv; n.Wp = reshapeMat(o.Wp, o.nPol, n.nHid); n.bp = o.bp; return n;
}
function freshNet(hidden) { return new Net(INPUT_DIM, hidden, NPOL); }
function writeAtomic(file, str) { const tmp = file + ".tmp" + process.pid; fs.writeFileSync(tmp, str); fs.renameSync(tmp, file); }
function loadCheckpoint(file) { if (!fs.existsSync(file)) return null; try { const o = JSON.parse(fs.readFileSync(file, "utf8")); return { net: netFromObj(o), iter: o.iter || 0 }; } catch (e) { return null; } }
function saveCheckpoint(file, net, iter) { writeAtomic(file, JSON.stringify(netToObj(net, iter))); }

module.exports = { Net, CribGame, NPOL, INPUT_DIM, makeRng, sampleSlot, argmaxLegal, randomLegal, selfPlay, train, evalVsRandom, netToObj, netFromObj, freshNet, writeAtomic, loadCheckpoint, saveCheckpoint, search };
