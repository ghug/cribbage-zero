#!/usr/bin/env node
/* engine/az_game.js — heads-up cribbage as a step-based search/RL environment (AlphaZero loop, layer 2).
 *
 * Exposes the game as a sequence of DECISION nodes (discard, pegging) with chance (deal, cut) and the
 * deterministic show resolved internally between decisions. Race to 121. Built for self-play + IS-MCTS:
 *   game.decision        → { player, phase, slots } at the current decision, or null when done
 *   game.step(slot)      → apply a move (a policy "slot"), auto-advance to the next decision/terminal
 *   game.encode(player)  → fixed-length feature vector from player's info set (opponent cards hidden)
 *   game.determinize(rng)→ a clone with the opponent's hidden cards resampled (for search)
 *   game.done, game.winner, game.scores
 *
 * Action SLOTS (fixed width 15 so one policy head spans both phases):
 *   discard  → slots 0..14 = the 15 two-card combos of the 6-card hand (i<j order)
 *   pegging  → slots 0..k  = the player's CURRENT hand cards (index order), masked to ≤31
 */
"use strict";
const fs = require("fs");
const path = require("path");
const eng = fs.readFileSync(path.join(__dirname, "..", "src", "engine.js"), "utf8");
const { scoreInto, pegScore, pval } = new Function(eng + "\n return { scoreInto, pegScore, pval };")();

const TARGET = 121;
const COMBOS6 = (() => { const o = []; for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) o.push([i, j]); return o; })();
const NPOL = 15;
const cardId = (c) => (c.r - 1) * 4 + c.s;

class CribGame {
  constructor(rng) {
    this.rng = rng;
    this.scores = [0, 0];
    this.dealer = (rng() * 2) | 0;
    this.done = false; this.winner = -1;
    this._deal();
  }
  _draw(n) { const out = []; while (out.length < n) { const i = (this.rng() * this._deck.length) | 0; out.push(this._deck.splice(i, 1)[0]); } return out; }
  _deal() {
    this._deck = []; for (let r = 1; r <= 13; r++) for (let s = 0; s < 4; s++) this._deck.push({ r, s });
    this.pone = 1 - this.dealer;
    this.six = [null, null];
    this.six[this.dealer] = this._draw(6); this.six[this.pone] = this._draw(6);
    this.kept = [null, null]; this.crib = []; this.starter = null;
    this.phase = "discard"; this.toAct = this.pone;          // pone discards first, then dealer
  }
  // ----- the public decision view -----
  get decision() {
    if (this.done) return null;
    return { player: this.toAct, phase: this.phase, slots: this._legalSlots() };
  }
  _legalSlots() {
    const legal = new Array(NPOL).fill(false);
    if (this.phase === "discard") { for (let j = 0; j < 15; j++) legal[j] = true; }
    else { // pegging: slot = index into the CURRENT hand (determinization-safe), legal if ≤31
      const hand = this._pegHand[this.toAct];
      for (let s = 0; s < hand.length; s++) if (pval(hand[s].r) + this._count <= 31) legal[s] = true;
    }
    return legal;
  }
  // ----- apply a slot, then run chance/deterministic steps to the next decision -----
  step(slot) {
    if (this.phase === "discard") {
      const [i, j] = COMBOS6[slot];
      const six = this.six[this.toAct];
      this.kept[this.toAct] = six.filter((_, k) => k !== i && k !== j);
      this.crib.push(six[i], six[j]);
      if (this.toAct === this.pone) { this.toAct = this.dealer; }   // dealer discards next
      else { this._afterDiscards(); }
      return;
    }
    // pegging — slot indexes the current hand
    const me = this.toAct, hand = this._pegHand[me], card = hand[slot];
    hand.splice(slot, 1);
    this._pile.push(card.r); this._played.push(card.r); this._count += pval(card.r);
    if (this._award(me, pegScore(this._pile, this._count))) return;
    this._pegLast = me; this._pegPasses = 0;
    if (this._count === 31) { this._count = 0; this._pile = []; this._pegLast = -1; }
    this._advancePeg();
  }
  _afterDiscards() {                                       // crib full → cut → his heels → start pegging
    this.starter = this._draw(1)[0];
    if (this.starter.r === 11) { if (this._award(this.dealer, 2)) return; }   // his heels
    this.phase = "peg";
    this._pegHand = [this.kept[0].slice(), this.kept[1].slice()];
    this._count = 0; this._pile = []; this._played = []; this._pegPasses = 0; this._pegLast = -1;
    this.toAct = this.pone;
    this._advancePeg(true);
  }
  _advancePeg(justStarted) {                               // resolve go's / find the next player with a legal move
    if (!justStarted) this.toAct = 1 - this.toAct;
    let guard = 0;
    while (guard++ < 20) {
      const remaining = this._pegHand[0].length + this._pegHand[1].length;
      if (remaining === 0) { if (this._pegLast >= 0) { if (this._award(this._pegLast, 1)) return; } return this._show(); }
      const hand = this._pegHand[this.toAct];
      const canPlay = hand.some((c) => pval(c.r) + this._count <= 31);
      if (canPlay) return;                                  // a real decision awaits
      // current player must "go"
      if (++this._pegPasses >= 2) { if (this._pegLast >= 0 && this._count !== 31) { if (this._award(this._pegLast, 1)) return; } this._count = 0; this._pile = []; this._pegPasses = 0; this._pegLast = -1; }
      this.toAct = 1 - this.toAct;
    }
  }
  _show() {                                                // pone, dealer, crib — stop the instant someone hits 121
    const acc = [0, 0, 0, 0, 0];
    if (this._award(this.pone, scoreInto(this.kept[this.pone], this.starter, false, acc))) return;
    if (this._award(this.dealer, scoreInto(this.kept[this.dealer], this.starter, false, acc))) return;
    if (this._award(this.dealer, scoreInto(this.crib, this.starter, true, acc))) return;
    this.dealer = 1 - this.dealer; this._deal();           // next hand
  }
  _award(seat, pts) {
    this.scores[seat] += pts;
    if (this.scores[seat] >= TARGET) { this.done = true; this.winner = seat; return true; }
    return false;
  }
  // ----- net interface -----
  encode(player) {                                         // fixed-length features from player's info set
    const f = [];
    const opp = 1 - player;
    // own visible cards (rank multiplicity 13): the six in discard, the kept-four after
    const mine = this.phase === "discard" ? this.six[player] : (this._pegHand ? this._pegHand[player] : this.kept[player]);
    const rc = new Array(13).fill(0); for (const c of mine) rc[c.r - 1]++; f.push(...rc.map((x) => x / 2));
    // phase one-hot, who deals, to-act-is-me
    f.push(this.phase === "discard" ? 1 : 0, this.phase === "peg" ? 1 : 0, this.dealer === player ? 1 : 0, this.toAct === player ? 1 : 0);
    // scores (to-go, normalized) — mine then opp
    f.push((TARGET - this.scores[player]) / TARGET, (TARGET - this.scores[opp]) / TARGET);
    // pegging context
    f.push((this._count || 0) / 31, this.phase === "peg" ? this._pegHand[player].length / 4 : 0, this.phase === "peg" ? this._pegHand[opp].length / 4 : 0);
    const tail = this.phase === "peg" && this._pile && this._pile.length ? this._pile[this._pile.length - 1] : 0;
    const tr = new Array(13).fill(0); if (tail) tr[tail - 1] = 1; f.push(...tr);
    // starter (known after the cut)
    const sr = new Array(13).fill(0); if (this.starter) sr[this.starter.r - 1] = 1; f.push(...sr);
    return f;
  }
  static get INPUT_DIM() { return 13 + 4 + 2 + 3 + 13 + 13; }
  static get NPOL() { return NPOL; }

  // clone with the opponent's hidden cards resampled from the unseen pool (for IS-MCTS determinization)
  determinize(player, rng) {
    const g = this.clone();
    const opp = 1 - player;
    // cards `player` can see: own cards (+played pile + starter); everything else is unseen → resample opp's
    const seen = new Set();
    const mine = g.phase === "discard" ? g.six[player] : g.kept[player];
    for (const c of mine) seen.add(cardId(c));
    if (g.starter) seen.add(cardId(g.starter));
    if (g._played) for (const r of g._played) { /* ranks only; can't pin suit — leave in pool */ }
    const pool = [];
    for (let r = 1; r <= 13; r++) for (let s = 0; s < 4; s++) { const c = { r, s }; if (!seen.has(cardId(c))) pool.push(c); }
    for (let i = pool.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    // give the opponent the right number of cards; keep ranks of any already-played opp cards consistent enough
    if (g.phase === "discard") { g.six[opp] = pool.slice(0, 6); }
    else if (g._pegHand) { g._pegHand[opp] = pool.slice(0, g._pegHand[opp].length); g.kept[opp] = g.kept[opp]; }
    return g;
  }
  clone() {
    const g = Object.create(CribGame.prototype);
    g.rng = this.rng; g.scores = this.scores.slice(); g.dealer = this.dealer; g.pone = this.pone;
    g.done = this.done; g.winner = this.winner; g.phase = this.phase; g.toAct = this.toAct;
    g.six = this.six ? this.six.map((h) => h && h.slice()) : this.six;
    g.kept = this.kept ? this.kept.map((h) => h && h.slice()) : this.kept;
    g.crib = this.crib ? this.crib.slice() : this.crib; g.starter = this.starter;
    g._pegHand = this._pegHand ? this._pegHand.map((h) => h.slice()) : undefined;
    g._count = this._count; g._pile = this._pile ? this._pile.slice() : this._pile;
    g._played = this._played ? this._played.slice() : this._played;
    g._pegPasses = this._pegPasses; g._pegLast = this._pegLast; g._deck = this._deck ? this._deck.slice() : this._deck;
    return g;
  }
}

module.exports = { CribGame };

/* ---------------- self-test: random self-play sanity ---------------- */
if (require.main === module) {
  let ok = 0, fail = 0;
  const check = (c, m) => { if (c) ok++; else { fail++; console.error("  ✗ " + m); } };
  let a = 12345; const rng = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  let games = 0, hands = 0, badScore = 0, badEncode = 0, badTerminal = 0, illegalEver = 0;
  for (let gi = 0; gi < 2000; gi++) {
    const g = new CribGame(rng);
    let prev = [0, 0], guard = 0;
    while (!g.done && guard++ < 4000) {
      const d = g.decision;
      const legalSlots = []; for (let s = 0; s < CribGame.NPOL; s++) if (d.slots[s]) legalSlots.push(s);
      if (legalSlots.length === 0) { illegalEver++; break; }
      if (g.encode(d.player).length !== CribGame.INPUT_DIM) badEncode++;
      if (g.scores[0] < prev[0] || g.scores[1] < prev[1]) badScore++;
      prev = g.scores.slice();
      g.step(legalSlots[(rng() * legalSlots.length) | 0]);
    }
    if (!g.done) badTerminal++;
    else { if (g.scores[g.winner] < TARGET) badScore++; if (g.scores[1 - g.winner] >= TARGET) badScore++; }
    games++;
  }
  check(badTerminal === 0, `all ${games} games reach a winner (${badTerminal} stalled)`);
  check(badScore === 0, `scores monotonic & exactly one side reaches 121 (${badScore} violations)`);
  check(badEncode === 0, `encode() is always INPUT_DIM=${CribGame.INPUT_DIM} (${badEncode} bad)`);
  check(illegalEver === 0, `every decision node offers ≥1 legal slot (${illegalEver} empties)`);

  // determinization keeps the acting player's own cards, resamples the opponent's legally
  { const g = new CribGame(rng); const d = g.determinize(g.toAct, rng); check(JSON.stringify(d.six[g.toAct]) === JSON.stringify(g.six[g.toAct]), "determinize preserves the actor's own hand"); }

  console.log(`\naz_game self-test: ${ok} passed, ${fail} failed  (${games} random games played out)`);
  process.exit(fail ? 1 : 0);
}
