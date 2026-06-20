/* Shared cribbage engine — the pure scoring + pegging math used by BOTH the Play game
 * (src/CribbagePlay.jsx) and the Discard Trainer (src/CribbageTrainer.jsx). `build.sh` PREPENDS
 * this file to each app before the name-guard + transpile, so every built page still ships one
 * self-contained copy (no bundler, no runtime module system). These definitions were byte-for-byte
 * identical in both apps; this is now the single source of truth for them.
 *
 * NOTE: the independent re-implementations under engine/ (the Node verification scripts) are
 * deliberately NOT shared — they re-prove this math from scratch as a second opinion. `handDetail`
 * is also kept per-app: the trainer's version returns extra distribution stats the game doesn't need.
 *
 * Cards are { r: 1..13, s: 0..3 } (r: A=1 … K=13; s: spade/heart/diamond/club).
 */

const fifteenVal = (r) => Math.min(r, 10);
const pval = (r) => Math.min(r, 10);
const cardId = (c) => (c.r - 1) * 4 + c.s;

function scoreInto(four, starter, isCrib, acc) {
  const all = [...four, starter];
  let f = 0, p = 0, ru = 0, fl = 0, no = 0;
  for (let m = 1; m < 32; m++) {
    let s = 0;
    for (let i = 0; i < 5; i++) if (m & (1 << i)) s += fifteenVal(all[i].r);
    if (s === 15) f += 2;
  }
  for (let i = 0; i < 5; i++)
    for (let j = i + 1; j < 5; j++) if (all[i].r === all[j].r) p += 2;
  const c = new Array(14).fill(0);
  for (const x of all) c[x.r]++;
  let r = 1;
  while (r <= 13) {
    if (!c[r]) { r++; continue; }
    let len = 0, pr = 1, rr = r;
    while (rr <= 13 && c[rr] > 0) { len++; pr *= c[rr]; rr++; }
    if (len >= 3) ru += len * pr;
    r = rr;
  }
  const s0 = four[0].s;
  if (four.every((x) => x.s === s0)) {
    if (starter.s === s0) fl += 5;
    else if (!isCrib) fl += 4;
  }
  for (const x of four) if (x.r === 11 && x.s === starter.s) no += 1;
  acc[0] += f; acc[1] += p; acc[2] += ru; acc[3] += fl; acc[4] += no;
  return f + p + ru + fl + no;
}

function lockedFour(four) {
  let f = 0, p = 0, ru = 0, fl = 0;
  for (let m = 1; m < 16; m++) {
    let s = 0;
    for (let i = 0; i < 4; i++) if (m & (1 << i)) s += fifteenVal(four[i].r);
    if (s === 15) f += 2;
  }
  for (let i = 0; i < 4; i++)
    for (let j = i + 1; j < 4; j++) if (four[i].r === four[j].r) p += 2;
  const c = new Array(14).fill(0);
  for (const x of four) c[x.r]++;
  let r = 1;
  while (r <= 13) {
    if (!c[r]) { r++; continue; }
    let len = 0, pr = 1, rr = r;
    while (rr <= 13 && c[rr] > 0) { len++; pr *= c[rr]; rr++; }
    if (len >= 3) ru += len * pr;
    r = rr;
  }
  if (four.every((x) => x.s === four[0].s)) fl += 4;
  return f + p + ru + fl;
}

function deckExcluding(cards) {
  const used = new Set(cards.map(cardId));
  const d = [];
  for (let r = 1; r <= 13; r++)
    for (let s = 0; s < 4; s++) { const c = { r, s }; if (!used.has(cardId(c))) d.push(c); }
  return d;
}

// Exact hand EV: enumerate every possible cut for a kept four and average the score. Returns the
// game-relevant fields (ev, sd, min/max, category breakdown, locked-in points, gain-from-cut) PLUS
// the analysis-only extras the trainer's table uses — p10/p90 spread and the top-3 best cut ranks.
// The Play game just ignores the extras; this is the unified version of what both apps computed.
function handDetail(four, dealt) {
  const deck = deckExcluding(dealt);
  const acc = [0, 0, 0, 0, 0];
  let total = 0, sq = 0, mn = 99, mx = 0;
  const byRank = {};
  const vals = [];
  for (const st of deck) {
    const t = scoreInto(four, st, false, acc);
    total += t; sq += t * t; if (t < mn) mn = t; if (t > mx) mx = t; vals.push(t);
    const b = byRank[st.r] || (byRank[st.r] = { sum: 0, n: 0 });
    b.sum += t; b.n++;
  }
  const n = deck.length;
  const ev = total / n;
  const sd = Math.sqrt(Math.max(0, sq / n - ev * ev));
  vals.sort((a, b) => a - b);
  const locked = lockedFour(four);
  const top = Object.keys(byRank)
    .map((r) => ({ r: +r, avg: byRank[r].sum / byRank[r].n, p: byRank[r].n / n }))
    .sort((a, b) => b.avg - a.avg).slice(0, 3);
  return { ev, sd, mn, mx, p10: vals[(n * 0.1) | 0], p90: vals[(n * 0.9) | 0], cats: acc.map((x) => x / n), locked, fromCut: ev - locked, top };
}

/* ===== Pegging (play phase) ===== suits are irrelevant to pegging, so the pile / hand arrays
   handed to pegScore & pegChoose are ranks 1..13. Scoring mechanics unit-tested in
   engine/pegging.js. The bots play a greedy point-grabbing policy with light defense. */
function pegScore(pile, count) {
  let pts = 0;
  if (count === 15) pts += 2;
  if (count === 31) pts += 2;
  const n = pile.length, last = pile[n - 1];
  let k = 1; for (let i = n - 2; i >= 0; i--) { if (pile[i] === last) k++; else break; }
  if (k >= 2) pts += k * (k - 1);
  for (let m = Math.min(n, 7); m >= 3; m--) {
    const tail = pile.slice(n - m);
    if (new Set(tail).size === m && Math.max(...tail) - Math.min(...tail) === m - 1) { pts += m; break; }
  }
  return pts;
}
function pegChoose(legal, count, pile, hand) {
  let best = null, bestKey = -1e9;
  for (const c of legal) {
    const nc = count + pval(c);
    const key0 = pegScore(pile.concat(c), nc) * 10;
    let key = key0;
    if (nc === 5 || nc === 21) key -= 2;
    if (count === 0) { if (c === 5) key -= 2; key -= pval(c) * 0.1; if (hand.filter((x) => x === c).length >= 2) key += 0.5; }
    else key -= pval(c) * 0.02;
    if (key > bestKey) { bestKey = key; best = c; }
  }
  return best;
}
// A stronger pegging policy than the greedy `pegChoose`: depth-1 expectimax. It maximizes the points
// the card scores NOW minus the points it hands the opponent on their immediate reply, averaged over
// the cards they could still hold — `unseen` = the full deck minus my hand, my discards, the starter,
// and every card already played (ranks; suits are irrelevant in pegging). Retains pegChoose's tactical
// tie-breakers. `PEG_DEF_W` and the expected-reply form were picked by a seat-swapped head-to-head vs
// greedy (engine/pegging.js): it nets ~0.45 more pegging points per hand; a worst-case (minimax) reply
// term overreacted and did worse. Clean-room — this is the "shallow expectiminimax" the project's next
// steps call for, using only the existing pegScore.
const PEG_DEF_W = 1.0;
function pegChooseDeep(legal, count, pile, hand, unseen) {
  const avail = {}; for (const r of unseen) avail[r] = (avail[r] || 0) + 1;
  const ranks = Object.keys(avail).map(Number), tot = unseen.length;
  let best = null, bestKey = -1e9;
  for (const c of legal) {
    const nc = count + pval(c);
    const myGain = pegScore(pile.concat(c), nc);
    let threat = 0, oppCanPlay = false;
    if (nc !== 31) {                                   // 31 ends the sub-round — the opponent gets no reply
      let num = 0;
      for (const r of ranks) if (pval(r) + nc <= 31) { num += avail[r] * pegScore(pile.concat(c, r), nc + pval(r)); oppCanPlay = true; }
      threat = tot > 0 ? num / tot : 0;                // expected points a random unseen reply would peg
    }
    let key = myGain * 10 - PEG_DEF_W * threat * 10;
    if (nc !== 31 && !oppCanPlay) key += 1;            // forcing the opponent to "go" is good (likely last card)
    if (nc === 5 || nc === 21) key -= 2;               // (the greedy tie-breakers, retained)
    if (count === 0) { if (c === 5) key -= 2; key -= pval(c) * 0.1; if (hand.filter((x) => x === c).length >= 2) key += 0.5; }
    else key -= pval(c) * 0.02;
    if (key > bestKey) { bestKey = key; best = c; }
  }
  return best;
}
