#!/usr/bin/env node
/* engine/eval_zero.js — DEV TOOL: measure the trained net and record it on the `progress` branch.
 *
 * Pulls the latest net from the `net` branch, plays a 10000-game seat-balanced match vs RANDOM and another
 * vs a HARD bot, and appends a "games,winPct" point to progress-random.csv and progress-hard.csv on the
 * `progress` branch. The self-play loop no longer benchmarks strength (it just trains), so this is how the
 * strength-over-games curves stay current — run it occasionally.
 *
 * The Zero side plays NATIVELY (az_game/az_net, greedy on the net's policy — same as evalVsRandom). The
 * HARD bot is a VENDORED snapshot of the cribbage-trainer heuristic: win-probability discard (src/winprob.js
 * winProbHand + handDetail) and depth-1 pegging (src/engine.js pegChooseDeep). It's a fixed benchmark and
 * may drift from the shipped hard bot over time — fine for a yardstick.
 *
 * Recording is a MANUAL step: after the eval prints, it asks for confirmation before appending to the
 * progress branch (answer y/N). Nothing is recorded automatically. `--dry` skips recording entirely (no
 * prompt); `--yes` approves it non-interactively (for scripts / a non-TTY).
 *
 * Run:  CZ_TOKEN=<github-pat> node engine/eval_zero.js [decks=5000] [--dry|--yes]   (decks×2 = games per match;
 *        recording requires ≥10000 balanced games, i.e. decks ≥ 5000)
 */
"use strict";
const fs = require("fs"), path = require("path"), readline = require("readline");
const { Net, CribGame, makeRng, argmaxLegal, randomLegal, netFromObj, evalVsRandom } = require("./az_common.js");

const REPO = "ghug/cribbage-zero", TARGET = 121, NPOL = 15;
const DECKS = parseInt(process.argv[2], 10) || 5000;
const DRY = process.argv.includes("--dry");
const YES = process.argv.includes("--yes") || process.argv.includes("-y");
const TOKEN = process.env.CZ_TOKEN || "";

// vendored hard-bot pieces: handDetail + pegChooseDeep + pval (cribbage-zero's own src/engine.js) and
// winProbHand (the vendored src/winprob.js) — captured the same way az_game.js loads the scoring.
const eng = fs.readFileSync(path.join(__dirname, "..", "src", "engine.js"), "utf8");
const wp = fs.readFileSync(path.join(__dirname, "..", "src", "winprob.js"), "utf8");
const { handDetail, pegChooseDeep, pval, winProbHand } = new Function(eng + "\n" + wp + "\n return { handDetail, pegChooseDeep, pval, winProbHand };")();

const CRIB_VALUE = [3.96, 3.95, 4.05, 4.06, 6.38, 4.10, 4.21, 4.34, 4.09, 3.74, 4.19, 3.73, 3.85];
const fifteen = (r) => Math.min(r, 10);
function cribSeed(a, b) { let v = (CRIB_VALUE[a.r - 1] + CRIB_VALUE[b.r - 1]) * .5; if (a.r === b.r) v += 2; else if (Math.abs(a.r - b.r) <= 2) v += .5; if (fifteen(a.r) + fifteen(b.r) === 15) v += 2; return v; }
const COMBOS6 = (() => { const o = []; for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) o.push([i, j]); return o; })();

// the HARD bot reading the CribGame's info-set, returning a policy slot (mirrors az_game's slot encoding)
function hardSlot(g, player) {
  if (g.phase === "discard") {                            // slot 0..14 = the 15 two-card throws (COMBOS6)
    const dealt = g.six[player], cribOurs = (g.dealer === player);
    const board = { yourToGo: TARGET - g.scores[player], oppToGo: TARGET - g.scores[1 - player], youDeal: cribOurs, P: 2, teams: 2 };
    let best = 0, bv = -1e9;
    for (let s = 0; s < NPOL; s++) {
      const [i, j] = COMBOS6[s];
      const four = dealt.filter((_, k) => k !== i && k !== j), thrown = [dealt[i], dealt[j]];
      const hd = handDetail(four, dealt), cv = cribSeed(thrown[0], thrown[1]);
      const v = winProbHand(board, hd.ev + (cribOurs ? cv : 0), hd.sd, cribOurs ? 0 : cv);
      if (v > bv) { bv = v; best = s; }
    }
    return best;
  }
  // pegging: slot = index into the current peg hand; choose with depth-1 expectimax
  const hand = g._pegHand[player], count = g._count, kept = g.kept[player];
  const acct = new Array(14).fill(0);                     // cards I can account for → opp pool = the rest
  for (const c of hand) acct[c.r]++;
  for (const c of g.six[player]) if (kept.indexOf(c) === -1) acct[c.r]++;   // my discards
  if (g.starter) acct[g.starter.r]++;
  for (const c of g._playedSuited) acct[c.r]++;           // everything played this hand
  const unseen = []; for (let r = 1; r <= 13; r++) { const a = 4 - acct[r]; for (let k = 0; k < a; k++) unseen.push(r); }
  const legalR = hand.filter((c) => pval(c.r) + count <= 31).map((c) => c.r);
  const cr = pegChooseDeep(legalR, count, g._pile.slice(), hand.map((c) => c.r), unseen);
  let slot = hand.findIndex((c) => c.r === cr && pval(c.r) + count <= 31);
  if (slot < 0) slot = g.decision.slots.findIndex(Boolean);
  return slot;
}

// net (greedy policy) vs the HARD bot; seats swapped each game — the vs-hard twin of az_common.evalVsRandom
function evalVsHard(net, games, rng) {
  let wins = 0;
  for (let gi = 0; gi < games; gi++) {
    const g = new CribGame(rng), netSeat = gi & 1; let guard = 0;
    while (!g.done && guard++ < 4000) {
      const p = g.toAct, legal = g.decision.slots;
      g.step(p === netSeat ? argmaxLegal(Net.softmax(net.forward(g.encode(p)).logits, legal), legal) : hardSlot(g, p));
    }
    if (g.winner === netSeat) wins++;
  }
  return wins / games;
}

// --- GitHub: pull the net; append a point to a CSV on the progress branch ---
const b64 = (s) => Buffer.from(s, "utf8").toString("base64"), unb64 = (s) => Buffer.from(s, "base64").toString("utf8");
async function gh(method, p, body) {
  const res = await fetch("https://api.github.com" + p, {
    method, headers: { Authorization: TOKEN ? "Bearer " + TOKEN : undefined, Accept: "application/vnd.github+json",
      "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cribbage-zero-eval" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text(); let j = null; try { j = JSON.parse(txt); } catch (e) {}
  if (res.status >= 400) throw new Error(method + " " + p.split("?")[0] + " -> " + res.status + (j && j.message ? " " + j.message : ""));
  return j;
}
async function appendPoint(file, games, pct) {                       // GET file+sha, append a row, PUT back (a commit on `progress`)
  const cur = await gh("GET", "/repos/" + REPO + "/contents/" + file + "?ref=progress");
  const content = unb64(cur.content).replace(/\n*$/, "\n") + games + "," + pct + "\n";
  await gh("PUT", "/repos/" + REPO + "/contents/" + file, { message: "eval @ " + games + " games: " + file + " " + pct + "%", content: b64(content), sha: cur.sha, branch: "progress" });
}

// manual approval gate: only record after the user confirms (or --yes). Non-TTY without --yes = decline.
function confirmRecord(games, vsRand, vsHard) {
  if (YES) return Promise.resolve(true);
  if (!process.stdin.isTTY) { console.log("eval_zero: not a TTY — re-run with --yes to record"); return Promise.resolve(false); }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const q = "eval_zero: record (" + games + "," + vsRand + ") + (" + games + "," + vsHard + ") to the progress branch? [y/N] ";
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(/^y(es)?$/i.test(a.trim())); }));
}

(async () => {
  console.log("eval_zero: pulling latest net from " + REPO + " @ net …");
  const ck = JSON.parse(unb64((await gh("GET", "/repos/" + REPO + "/contents/checkpoints/az_checkpoint.json?ref=net")).content));
  const net = netFromObj(ck), games = ck.games || 0;
  const seed = (Date.now() ^ 0x5eed) >>> 0;
  console.log("eval_zero: net @ " + games.toLocaleString() + " games — " + (DECKS * 2) + " balanced games per match …");
  const vsRand = +(100 * evalVsRandom(net, DECKS * 2, makeRng(seed))).toFixed(1);
  console.log("  vs RANDOM: " + vsRand + "%");
  const vsHard = +(100 * evalVsHard(net, DECKS * 2, makeRng(seed))).toFixed(1);
  console.log("  vs HARD:   " + vsHard + "%");

  if (DRY) { console.log("eval_zero: [dry] not recorded"); return; }
  if (DECKS * 2 < 10000) { console.log("eval_zero: " + (DECKS * 2) + " balanced games < 10000 minimum — not recording (use decks ≥ 5000)"); return; }
  if (!(await confirmRecord(games, vsRand, vsHard))) { console.log("eval_zero: not recorded"); return; }
  if (!TOKEN) { console.log("eval_zero: no CZ_TOKEN set — cannot record"); return; }
  await appendPoint("progress-random.csv", games, vsRand);
  await appendPoint("progress-hard.csv", games, vsHard);
  console.log("eval_zero: appended (" + games + "," + vsRand + ") and (" + games + "," + vsHard + ") to the progress branch");
})().catch((e) => { console.error("eval_zero:", e.stack || e.message); process.exit(1); });
