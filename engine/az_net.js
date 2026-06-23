#!/usr/bin/env node
/* engine/az_net.js — the value+policy network for the from-random AlphaZero loop (layer 1).
 *
 * A hand-rolled multilayer perceptron (no deps): a stack of ReLU hidden layers feeding two heads — a
 * scalar VALUE (tanh, ∈[-1,1], the player-to-move's expected game result) and POLICY logits over the
 * fixed action-slot set (softmax is taken over the LEGAL slots at use time). Weights start random —
 * tabula rasa. Trained by SGD on AlphaZero's targets: value ← the actual outcome z, policy ← the MCTS
 * visit distribution π.  Loss = ½(v−z)² + (−Σ_legal π·log softmax(logits)).
 *
 * The architecture is configurable: `new Net(nIn, hidden, nPol)` where `hidden` is an array of layer
 * sizes (e.g. [256,256,256,256]) — or a single number for a one-hidden-layer net. The forward pass,
 * the hand-written backprop, and (de)serialization all flow from that array. ReLU hidden layers use
 * He-uniform init; pass an explicit seedW to override (the gradient check does). Ships with a numeric
 * gradient check + a toy-learning test so we KNOW the backprop is right before the rest depends on it.
 * Run: node engine/az_net.js
 */
"use strict";

function randu(r) { return (Math.random() * 2 - 1) * r; }

class Net {
  constructor(nIn, hidden, nPol, seedW = null) {
    if (typeof hidden === "number") hidden = [hidden];
    this.nIn = nIn; this.hidden = hidden.slice(); this.nPol = nPol;
    this.nHid = hidden[hidden.length - 1];                       // last hidden width — the heads read this
    const sizes = [nIn].concat(hidden);
    this.W = []; this.b = [];                                    // W[l] is sizes[l+1] × sizes[l]; b[l] length sizes[l+1]
    for (let l = 0; l < hidden.length; l++) {
      const din = sizes[l], dout = sizes[l + 1], r = seedW != null ? seedW : Math.sqrt(6 / din);  // He-uniform for ReLU
      this.W.push(Array.from({ length: dout }, () => Array.from({ length: din }, () => randu(r))));
      this.b.push(new Array(dout).fill(0));
    }
    const last = this.nHid, rh = seedW != null ? seedW : Math.sqrt(6 / last);
    this.Wv = Array.from({ length: last }, () => randu(rh)); this.bv = 0;
    this.Wp = Array.from({ length: nPol }, () => Array.from({ length: last }, () => randu(rh)));
    this.bp = new Array(nPol).fill(0);
  }

  forward(x) {
    const acts = [x]; let a = x;                                 // acts[l] = input to layer l (acts[0] = x)
    for (let l = 0; l < this.W.length; l++) {
      const W = this.W[l], b = this.b[l], dout = b.length, din = a.length, o = new Array(dout);
      // 4-way row blocking: load each a[k] once and fan it across 4 output neurons (≈2.4× over the naive
      // row-at-a-time loop — the inner-loop a[k] reload was the bottleneck). Bit-identical to the scalar form.
      let i = 0;
      for (; i + 4 <= dout; i += 4) {
        const W0 = W[i], W1 = W[i + 1], W2 = W[i + 2], W3 = W[i + 3];
        let s0 = b[i], s1 = b[i + 1], s2 = b[i + 2], s3 = b[i + 3];
        for (let k = 0; k < din; k++) { const ak = a[k]; s0 += W0[k] * ak; s1 += W1[k] * ak; s2 += W2[k] * ak; s3 += W3[k] * ak; }
        o[i] = s0 > 0 ? s0 : 0; o[i + 1] = s1 > 0 ? s1 : 0; o[i + 2] = s2 > 0 ? s2 : 0; o[i + 3] = s3 > 0 ? s3 : 0;   // ReLU
      }
      for (; i < dout; i++) { let s = b[i], Wi = W[i]; for (let k = 0; k < din; k++) s += Wi[k] * a[k]; o[i] = s > 0 ? s : 0; }  // tail (dout % 4)
      a = o; acts.push(a);
    }
    const hLast = a, last = hLast.length;
    let zv = this.bv; for (let i = 0; i < last; i++) zv += this.Wv[i] * hLast[i];
    const v = Math.tanh(zv);
    const logits = new Array(this.nPol);
    for (let j = 0; j < this.nPol; j++) { let s = this.bp[j], Wj = this.Wp[j]; for (let i = 0; i < last; i++) s += Wj[i] * hLast[i]; logits[j] = s; }
    return { acts, h: hLast, v, logits };
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
    const nPol = this.nPol;
    const f = this.forward(x), acts = f.acts, hLast = f.h, v = f.v, last = hLast.length;
    const p = Net.softmax(f.logits, legal);

    // --- head gradients (computed at the current weights, before any update) ---
    const dv = (v - z), dzv = dv * (1 - v * v);                  // ½(v−z)² → dL/dzv via tanh'
    const dlog = new Array(nPol).fill(0);                        // softmax+CE → dlogit_j = p_j − pi_j (legal only)
    for (let j = 0; j < nPol; j++) if (legal[j]) dlog[j] = cPol * (p[j] - pi[j]);
    // grad wrt the last hidden activation (uses pre-update head weights)
    let dA = new Array(last);
    for (let i = 0; i < last; i++) { let s = dzv * this.Wv[i]; for (let j = 0; j < nPol; j++) if (legal[j]) s += dlog[j] * this.Wp[j][i]; dA[i] = s; }

    // --- update heads ---
    this.bv -= lr * dzv; for (let i = 0; i < last; i++) this.Wv[i] -= lr * dzv * hLast[i];
    for (let j = 0; j < nPol; j++) if (legal[j]) { this.bp[j] -= lr * dlog[j]; const Wj = this.Wp[j]; for (let i = 0; i < last; i++) Wj[i] -= lr * dlog[j] * hLast[i]; }

    // --- backprop through the ReLU hidden layers, last → first (dIn computed with pre-update W, then W updated) ---
    for (let l = this.W.length - 1; l >= 0; l--) {
      const aOut = acts[l + 1], aIn = acts[l], dout = aOut.length, din = aIn.length;
      const dZ = new Array(dout);
      for (let i = 0; i < dout; i++) dZ[i] = aOut[i] > 0 ? dA[i] : 0;   // ReLU'(z) = [aOut > 0]
      let dIn = null;
      if (l > 0) { dIn = new Array(din).fill(0); for (let i = 0; i < dout; i++) { const g = dZ[i]; if (g) { const Wi = this.W[l][i]; for (let k = 0; k < din; k++) dIn[k] += g * Wi[k]; } } }
      const W = this.W[l], b = this.b[l];
      for (let i = 0; i < dout; i++) { const g = dZ[i]; b[i] -= lr * g; if (g) { const Wi = W[i]; for (let k = 0; k < din; k++) Wi[k] -= lr * g * aIn[k]; } }
      dA = dIn;
    }

    let lp = 0; for (let j = 0; j < nPol; j++) if (legal[j] && pi[j] > 0) lp -= pi[j] * Math.log(Math.max(1e-12, p[j]));
    return 0.5 * dv * dv + cPol * lp;
  }
}

module.exports = { Net };

/* ---------------- self-test: numerical gradient check + toy learning ---------------- */
if (require.main === module) {
  let ok = 0, fail = 0;
  const check = (c, m) => { if (c) ok++; else { fail++; console.error("  ✗ " + m); } };

  function loss(net, x, z, pi, legal, cPol = 1.0) {
    const f = net.forward(x), p = Net.softmax(f.logits, legal);
    let lp = 0; for (let j = 0; j < pi.length; j++) if (legal[j] && pi[j] > 0) lp -= pi[j] * Math.log(Math.max(1e-12, p[j]));
    return 0.5 * (f.v - z) ** 2 + cPol * lp;
  }
  function numGrad(net, x, z, pi, legal, get, set) {
    const e = 1e-5, v0 = get();
    set(v0 + e); const lp = loss(net, x, z, pi, legal);
    set(v0 - e); const lm = loss(net, x, z, pi, legal);
    set(v0); return (lp - lm) / (2 * e);
  }
  // gradient check on a MULTI-LAYER net. Analytic grads come from the exact relation Δθ = −lr·grad that
  // trainStep applies (grads are all evaluated at the pre-step weights), compared to finite differences.
  {
    const net = new Net(5, [6, 4], 3, 0.5);                      // 2 hidden layers exercise the full chain
    const x = [0.4, -0.7, 0.1, 0.9, -0.3], z = 0.3, legal = [true, true, false], pi = [0.6, 0.4, 0];   // pi normalized over legal slots (as MCTS produces)
    const params = [
      { name: "W[0][2][3]", get: () => net.W[0][2][3], set: (v) => (net.W[0][2][3] = v) },
      { name: "b[0][1]", get: () => net.b[0][1], set: (v) => (net.b[0][1] = v) },
      { name: "W[1][3][2]", get: () => net.W[1][3][2], set: (v) => (net.W[1][3][2] = v) },
      { name: "b[1][2]", get: () => net.b[1][2], set: (v) => (net.b[1][2] = v) },
      { name: "Wv[3]", get: () => net.Wv[3], set: (v) => (net.Wv[3] = v) },
      { name: "Wp[0][1]", get: () => net.Wp[0][1], set: (v) => (net.Wp[0][1] = v) },
      { name: "bp[2]", get: () => net.bp[2], set: (v) => (net.bp[2] = v) },
    ];
    const nG = params.map((pr) => numGrad(net, x, z, pi, legal, pr.get, pr.set));   // pristine net
    const before = params.map((pr) => pr.get());
    const lr = 1.0;
    net.trainStep(x, z, pi, legal, lr);
    params.forEach((pr, i) => {
      const aG = (before[i] - pr.get()) / lr;                    // exact: trainStep did θ -= lr·grad
      check(Math.abs(aG - nG[i]) < 1e-5, `${pr.name} grad matches numeric (${aG.toFixed(6)} vs ${nG[i].toFixed(6)})`);
    });
  }

  // toy learning: can a small ReLU net fit a known value+policy mapping from random init?
  {
    const net = new Net(4, [16, 16], 3);                         // 2 layers, He init
    const legal = [true, true, true];
    const sample = () => { const x = [Math.random(), Math.random(), Math.random(), Math.random()]; const z = Math.tanh(2 * (x[0] - x[1])); const best = x[0] > x[2] ? (x[1] > 0.5 ? 0 : 1) : 2; const pi = [0, 0, 0]; pi[best] = 1; return { x, z, pi, best }; };
    let before = 0; for (let i = 0; i < 400; i++) { const s = sample(); before += loss(net, s.x, s.z, s.pi, legal); } before /= 400;
    for (let it = 0; it < 60000; it++) { const s = sample(); net.trainStep(s.x, s.z, s.pi, legal, 0.03); }
    let after = 0, correct = 0; for (let i = 0; i < 1000; i++) { const s = sample(); after += loss(net, s.x, s.z, s.pi, legal); const f = net.forward(s.x); const p = Net.softmax(f.logits, legal); let arg = 0; for (let j = 1; j < 3; j++) if (p[j] > p[arg]) arg = j; if (arg === s.best) correct++; } after /= 1000;
    check(after < before * 0.5, `toy loss drops with training (${before.toFixed(3)} → ${after.toFixed(3)})`);
    check(correct / 1000 > 0.9, `toy policy accuracy after training: ${(correct / 10).toFixed(1)}%`);
    console.log(`  toy: loss ${before.toFixed(3)} → ${after.toFixed(3)}, policy acc ${(correct / 10).toFixed(1)}%`);
  }

  console.log(`\naz_net self-test: ${ok} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
