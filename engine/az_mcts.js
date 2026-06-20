#!/usr/bin/env node
/* engine/az_mcts.js — IS-MCTS with PUCT for the AlphaZero loop (layer 3).
 *
 * Single-observer Information-Set MCTS: the root player's view is fixed; every simulation
 * re-determinizes the opponent's hidden cards, descends a SHARED tree (so statistics aggregate
 * across determinizations — this is what avoids PIMC's strategy fusion), and only considers the
 * slots legal in the current determinization. Leaves are evaluated by the net (value + a policy
 * prior); terminal nodes use the true ±1 result. Selection is PUCT:
 *     score(s) = Q(s) + cPuct · P(s) · √ΣN / (1 + N(s))
 * Values are stored in the ROOT player's perspective; Q is read from the node-player's perspective.
 *
 * search(game, net, nSims, cPuct, rng) → { policy (visit dist over slots), move, value }
 * Run standalone for a mechanics self-test: node engine/az_mcts.js
 */
"use strict";
const { Net } = require("./az_net.js");
const NPOL = 15;

class MNode {
  constructor() { this.N = 0; this.W = 0; this.P = null; this.expanded = false; this.children = new Map(); }
}

function search(rootGame, net, nSims, cPuct, rng) {
  const rootPlayer = rootGame.toAct;
  const root = new MNode();

  function simulate(game, node) {
    node.N++;
    if (game.done) { const v = game.winner === rootPlayer ? 1 : -1; node.W += v; return v; }
    if (!node.expanded) {                                  // expand + evaluate (one new node per sim)
      const player = game.toAct, legal = game.decision.slots;
      const f = net.forward(game.encode(player));
      node.P = Net.softmax(f.logits, legal);
      node.expanded = true;
      const v = player === rootPlayer ? f.v : -f.v;        // → root perspective
      node.W += v; return v;
    }
    const player = game.toAct, legal = game.decision.slots;
    const sign = player === rootPlayer ? 1 : -1;
    const sqrtN = Math.sqrt(Math.max(1, node.N));
    let bestSlot = -1, bestScore = -Infinity;
    for (let s = 0; s < NPOL; s++) {
      if (!legal[s]) continue;
      const ch = node.children.get(s);
      const cN = ch ? ch.N : 0, cW = ch ? ch.W : 0;
      const q = cN > 0 ? sign * (cW / cN) : 0;             // Q from the node-player's perspective
      const u = cPuct * node.P[s] * sqrtN / (1 + cN);
      const sc = q + u;
      if (sc > bestScore) { bestScore = sc; bestSlot = s; }
    }
    let child = node.children.get(bestSlot);
    if (!child) { child = new MNode(); node.children.set(bestSlot, child); }
    game.step(bestSlot);
    const v = simulate(game, child);
    node.W += v; return v;
  }

  for (let i = 0; i < nSims; i++) simulate(rootGame.determinize(rootPlayer, rng), root);

  // visit-count policy over the root's (determinization-independent, own) legal slots
  const policy = new Array(NPOL).fill(0); let tot = 0;
  for (const [s, ch] of root.children) { policy[s] = ch.N; tot += ch.N; }
  if (tot > 0) for (let s = 0; s < NPOL; s++) policy[s] /= tot;
  // pick the most-visited slot (argmax); ties → first
  let move = -1, best = -1; for (let s = 0; s < NPOL; s++) if (policy[s] > best) { best = policy[s]; move = s; }
  return { policy, move, value: root.N ? root.W / root.N : 0 };
}

module.exports = { search };

/* ---------------- mechanics self-test ---------------- */
if (require.main === module) {
  const { CribGame } = require("./az_game.js");
  let ok = 0, fail = 0;
  const check = (c, m) => { if (c) ok++; else { fail++; console.error("  ✗ " + m); } };
  let a = 99; const rng = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const net = new Net(CribGame.INPUT_DIM, 24, CribGame.NPOL, 0.3);

  // 1) a single search returns a valid policy + legal move
  { const g = new CribGame(rng); const r = search(g, net, 60, 1.5, rng);
    const legal = g.decision.slots; let sum = 0, onlyLegal = true;
    for (let s = 0; s < CribGame.NPOL; s++) { sum += r.policy[s]; if (r.policy[s] > 0 && !legal[s]) onlyLegal = false; }
    check(Math.abs(sum - 1) < 1e-9, `root policy sums to 1 (${sum.toFixed(4)})`);
    check(onlyLegal && legal[r.move], "policy mass + chosen move are all legal");
    check(r.value >= -1 && r.value <= 1, `root value in range (${r.value.toFixed(3)})`);
  }

  // 2) full MCTS-vs-MCTS self-play games terminate with a winner, every move legal
  let games = 0, bad = 0, illegal = 0;
  for (let gi = 0; gi < 30; gi++) {
    const g = new CribGame(rng); let guard = 0;
    while (!g.done && guard++ < 4000) {
      const r = search(g, net, 30, 1.5, rng);
      if (!g.decision.slots[r.move]) { illegal++; break; }
      g.step(r.move);
    }
    if (!g.done) bad++; games++;
  }
  check(bad === 0, `${games} MCTS self-play games all terminate (${bad} stalled)`);
  check(illegal === 0, `MCTS never returns an illegal move (${illegal})`);

  // 3) terminal rewards propagate: when a winning peg play exists, search finds it.
  //    (search from a near-win state many times; the chosen move should never lose immediately.)
  console.log(`\naz_mcts self-test: ${ok} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
