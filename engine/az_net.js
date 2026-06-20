#!/usr/bin/env node
/* engine/az_net.js — the value+policy network for the from-random AlphaZero loop (layer 1).
 *
 * A hand-rolled MLP (no deps): one tanh hidden trunk feeding two heads — a scalar VALUE (tanh,
 * ∈[-1,1], the expected game result for the player to move) and POLICY logits over a fixed action
 * slot set (softmax is taken over the LEGAL slots at use time). Weights start random — tabula rasa.
 * Trained by SGD on AlphaZero's targets: value ← the actual game outcome z, policy ← the MCTS visit
 * distribution π.  Loss = ½(v−z)² + (−Σ_legal π·log softmax(logits)).
 *
 * This file is just the differentiable core; the game model, IS-MCTS, and the self-play/training
 * loop build on top. It ships with a numerical gradient check + a toy-learning test so we KNOW the
 * backprop is right before the rest depends on it.  Run: node engine/az_net.js
 */
"use strict";

function randn(scale) { return (Math.random() * 2 - 1) * scale; }

class Net {
  constructor(nIn, nHid, nPol, seedW = 0.3) {
    this.nIn = nIn; this.nHid = nHid; this.nPol = nPol;
    this.W1 = Array.from({ length: nHid }, () => Array.from({ length: nIn }, () => randn(seedW)));
    this.b1 = new Array(nHid).fill(0);
    this.Wv = Array.from({ length: nHid }, () => randn(seedW));
    this.bv = 0;
    this.Wp = Array.from({ length: nPol }, () => Array.from({ length: nHid }, () => randn(seedW)));
    this.bp = new Array(nPol).fill(0);
  }

  forward(x) {
    const { nHid, nPol } = this;
    const h = new Array(nHid), z1 = new Array(nHid);
    for (let i = 0; i < nHid; i++) { let s = this.b1[i], Wi = this.W1[i]; for (let k = 0; k < this.nIn; k++) s += Wi[k] * x[k]; z1[i] = s; h[i] = Math.tanh(s); }
    let zv = this.bv; for (let i = 0; i < nHid; i++) zv += this.Wv[i] * h[i];
    const v = Math.tanh(zv);
    const logits = new Array(nPol);
    for (let j = 0; j < nPol; j++) { let s = this.bp[j], Wj = this.Wp[j]; for (let i = 0; i < nHid; i++) s += Wj[i] * h[i]; logits[j] = s; }
    return { h, v, logits };
  }

  // masked softmax over the legal slots (legal = boolean array length nPol)
  static softmax(logits, legal) {
    let mx = -Infinity; for (let j = 0; j < logits.length; j++) if (legal[j] && logits[j] > mx) mx = logits[j];
    const p = new Array(logits.length).fill(0); let sum = 0;
    for (let j = 0; j < logits.length; j++) if (legal[j]) { p[j] = Math.exp(logits[j] - mx); sum += p[j]; }
    for (let j = 0; j < logits.length; j++) if (legal[j]) p[j] /= sum;
    return p;
  }

  // one SGD step on a single example; returns the loss. pi: target visit dist (0 on illegal), z: outcome.
  trainStep(x, z, pi, legal, lr, cPol = 1.0) {
    const { nIn, nHid, nPol } = this;
    const f = this.forward(x), h = f.h, v = f.v;
    const p = Net.softmax(f.logits, legal);

    // --- gradients ---
    // value head
    const dv = (v - z), dzv = dv * (1 - v * v);          // ½(v−z)² → dL/dzv via tanh'
    // policy head: softmax+cross-entropy → dlogit_j = p_j − pi_j (on legal; 0 on illegal)
    const dlog = new Array(nPol).fill(0);
    for (let j = 0; j < nPol; j++) if (legal[j]) dlog[j] = cPol * (p[j] - pi[j]);
    // backprop into hidden
    const dh = new Array(nHid).fill(0);
    for (let i = 0; i < nHid; i++) { let s = dzv * this.Wv[i]; for (let j = 0; j < nPol; j++) if (legal[j]) s += dlog[j] * this.Wp[j][i]; dh[i] = s; }
    const dz1 = new Array(nHid); for (let i = 0; i < nHid; i++) dz1[i] = dh[i] * (1 - h[i] * h[i]);

    // --- SGD update ---
    this.bv -= lr * dzv; for (let i = 0; i < nHid; i++) this.Wv[i] -= lr * dzv * h[i];
    for (let j = 0; j < nPol; j++) if (legal[j]) { this.bp[j] -= lr * dlog[j]; const Wj = this.Wp[j]; for (let i = 0; i < nHid; i++) Wj[i] -= lr * dlog[j] * h[i]; }
    for (let i = 0; i < nHid; i++) { this.b1[i] -= lr * dz1[i]; const Wi = this.W1[i]; for (let k = 0; k < nIn; k++) Wi[k] -= lr * dz1[i] * x[k]; }

    // loss (for reporting)
    let lp = 0; for (let j = 0; j < nPol; j++) if (legal[j] && pi[j] > 0) lp -= pi[j] * Math.log(Math.max(1e-12, p[j]));
    return 0.5 * dv * dv + cPol * lp;
  }
}

module.exports = { Net };

/* ---------------- self-test: numerical gradient check + toy learning ---------------- */
if (require.main === module) {
  let ok = 0, fail = 0;
  const check = (c, m) => { if (c) ok++; else { fail++; console.error("  ✗ " + m); } };

  // loss of a net on one example (for finite-difference checks)
  function loss(net, x, z, pi, legal, cPol = 1.0) {
    const f = net.forward(x), p = Net.softmax(f.logits, legal);
    let lp = 0; for (let j = 0; j < pi.length; j++) if (legal[j] && pi[j] > 0) lp -= pi[j] * Math.log(Math.max(1e-12, p[j]));
    return 0.5 * (f.v - z) ** 2 + cPol * lp;
  }
  // numerical gradient of the loss wrt a scalar at net.path (mutates+restores)
  function numGrad(net, x, z, pi, legal, get, set) {
    const e = 1e-5, v0 = get();
    set(v0 + e); const lp = loss(net, x, z, pi, legal);
    set(v0 - e); const lm = loss(net, x, z, pi, legal);
    set(v0); return (lp - lm) / (2 * e);
  }
  {
    const net = new Net(5, 6, 4, 0.5);
    const x = [0.4, -0.7, 0.1, 0.9, -0.3], z = 0.3, legal = [true, true, false, true];
    const pi = [0.5, 0.2, 0, 0.3];
    // analytic grads: capture by running a no-update backward (recompute by hand from trainStep math)
    const f = net.forward(x), p = Net.softmax(f.logits, legal);
    const dzv = (f.v - z) * (1 - f.v * f.v);
    const dlog = legal.map((L, j) => (L ? (p[j] - pi[j]) : 0));
    // check dL/dWv[2] and dL/dbp[1] and dL/dW1[0][3] against numeric
    const aWv2 = dzv * f.h[2];
    const nWv2 = numGrad(net, x, z, pi, legal, () => net.Wv[2], (v) => net.Wv[2] = v);
    check(Math.abs(aWv2 - nWv2) < 1e-6, `value-head grad matches numeric (${aWv2.toFixed(6)} vs ${nWv2.toFixed(6)})`);
    const abp1 = dlog[1];
    const nbp1 = numGrad(net, x, z, pi, legal, () => net.bp[1], (v) => net.bp[1] = v);
    check(Math.abs(abp1 - nbp1) < 1e-6, `policy-head grad matches numeric (${abp1.toFixed(6)} vs ${nbp1.toFixed(6)})`);
    // hidden-layer weight via full chain
    let dh0 = dzv * net.Wv[0]; for (let j = 0; j < 4; j++) if (legal[j]) dh0 += dlog[j] * net.Wp[j][0];
    const aW1_0_3 = dh0 * (1 - f.h[0] * f.h[0]) * x[3];
    const nW1_0_3 = numGrad(net, x, z, pi, legal, () => net.W1[0][3], (v) => net.W1[0][3] = v);
    check(Math.abs(aW1_0_3 - nW1_0_3) < 1e-6, `hidden-layer grad matches numeric (${aW1_0_3.toFixed(6)} vs ${nW1_0_3.toFixed(6)})`);
  }

  // toy learning: can it fit a known value+policy mapping from random init?
  {
    const net = new Net(4, 16, 3, 0.3);
    const legal = [true, true, true];
    const sample = () => { const x = [Math.random(), Math.random(), Math.random(), Math.random()]; const z = Math.tanh(2 * (x[0] - x[1])); const best = x[0] > x[2] ? (x[1] > 0.5 ? 0 : 1) : 2; const pi = [0, 0, 0]; pi[best] = 1; return { x, z, pi, best }; };
    let before = 0; for (let i = 0; i < 400; i++) { const s = sample(); before += loss(net, s.x, s.z, s.pi, legal); } before /= 400;
    for (let it = 0; it < 60000; it++) { const s = sample(); net.trainStep(s.x, s.z, s.pi, legal, 0.05); }
    let after = 0, correct = 0; for (let i = 0; i < 1000; i++) { const s = sample(); after += loss(net, s.x, s.z, s.pi, legal); const f = net.forward(s.x); const p = Net.softmax(f.logits, legal); let arg = 0; for (let j = 1; j < 3; j++) if (p[j] > p[arg]) arg = j; if (arg === s.best) correct++; } after /= 1000;
    check(after < before * 0.5, `toy loss drops with training (${before.toFixed(3)} → ${after.toFixed(3)})`);
    check(correct / 1000 > 0.9, `toy policy accuracy after training: ${(correct / 10).toFixed(1)}%`);
    console.log(`  toy: loss ${before.toFixed(3)} → ${after.toFixed(3)}, policy acc ${(correct / 10).toFixed(1)}%`);
  }

  console.log(`\naz_net self-test: ${ok} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
