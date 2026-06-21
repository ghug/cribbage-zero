/* src/winprob.js — real win-probability model (engine item #2).
 *
 * Replaces the old σ board-heuristic (±RISK·σ + the ev/need/protect modes). Instead of
 * rewarding/penalizing volatility, it asks the real question: "which discard maximizes my
 * probability of WINNING the race to the target?" Risk-seeking when behind and risk-averse
 * when ahead fall out automatically from the curvature of the win-prob surface.
 *
 * Build-time: PREPENDED into trainer.html and play.html by build.sh (after engine.js), so it
 * ships self-contained in every page — no bundler, no import. Defines window globals:
 *   winProb(board)                      → P(you/your team win) from the current board state
 *   winProbHand(board, mean, sd, oppAdd)→ E[win-prob] after one hand whose YOUR-side increment
 *                                          is ~Normal(mean,sd) and which gifts the opponent
 *                                          `oppAdd` extra points (your crib when you're pone)
 *
 * Two paths (the "hybrid"):
 *   • Heads-up (P=2): an exact dynamic program over the (yourToGo, oppToGo, whoseDeal) state
 *     space, built once at first use from the baked per-hand increment histograms.
 *   • 3–6 / teams: an analytic normal-approximation race (closed form) over per-config per-hand
 *     team increment mean/var — cheap and general.
 *
 * The baked stats come from `node engine/selfplay.js` (full-game self-play with hard bots).
 * They are policy-dependent — regenerate after any change to how the bots play.
 */

/* ===== BAKED self-play increment stats (engine/selfplay.js → engine/winprob_stats.json) ===== */
const WINPROB_STATS = {
  // heads-up per-hand points, board-neutral. pmf[k] = P(a side scores exactly k points in one hand).
  // From `node engine/selfplay.js 20000` (hard bots, full-game self-play). Regenerate after any
  // change to how the bots discard/peg (engine/winprob_stats.json is the raw output).
  headsUp: {
    dealer: { mean: 16.653, pmf: [0, 0, 0.00005, 0.0009, 0.00125, 0.0045, 0.00735, 0.01505, 0.0174, 0.032, 0.0373, 0.05545, 0.05615, 0.0724, 0.0725, 0.07815, 0.0719, 0.07175, 0.0669, 0.0607, 0.05205, 0.04855, 0.0374, 0.0303, 0.02715, 0.02065, 0.0164, 0.01265, 0.00855, 0.0069, 0.00485, 0.0031, 0.00285, 0.0019, 0.0017, 0.00095, 0.0006, 0.00065, 0.0002, 0.00015, 0.00015, 0.00015, 0.00005, 0.00025, 0.0001, 0, 0, 0, 0, 0, 0, 0, 0.00005] },
    pone: { mean: 10.7934, pmf: [0.00055, 0.0013, 0.0069, 0.0179, 0.03205, 0.0549, 0.05635, 0.08315, 0.0794, 0.1104, 0.08715, 0.0824, 0.0721, 0.07245, 0.04535, 0.04635, 0.0338, 0.0301, 0.0241, 0.0163, 0.0125, 0.00875, 0.0071, 0.0051, 0.00445, 0.0031, 0.00185, 0.00085, 0.0011, 0.0005, 0.00035, 0.00065, 0.00035, 0.00015, 0.00005, 0.00005, 0.00005, 0, 0.00005] },
  },
  // per-config team per-hand points: dealer-team vs other-team {mean, var}; target for the size.
  general: {
    "2-2": { target: 121, deal: { mean: 16.795, var: 29.066 }, def: { mean: 10.832, var: 21.986 } },
    "3-3": { target: 121, deal: { mean: 15.213, var: 30.044 }, def: { mean: 9.312, var: 19.405 } },
    "4-4": { target: 121, deal: { mean: 14.899, var: 31.521 }, def: { mean: 9.756, var: 19.827 } },
    "4-2": { target: 121, deal: { mean: 25.155, var: 48.978 }, def: { mean: 19.53, var: 39.66 } },
    "5-5": { target: 61, deal: { mean: 12.866, var: 28.343 }, def: { mean: 9.935, var: 20.021 } },
    "6-6": { target: 61, deal: { mean: 13.217, var: 29.698 }, def: { mean: 9.685, var: 20.321 } },
    "6-3": { target: 61, deal: { mean: 23.629, var: 53.475 }, def: { mean: 18.951, var: 39.862 } },
    "6-2": { target: 61, deal: { mean: 33.413, var: 67.002 }, def: { mean: 28.146, var: 57.098 } },
  },
};

const WP_TARGET = (P) => (P >= 5 ? 61 : 121);

/* ---------- helpers ---------- */
// standard normal CDF (Abramowitz-Stegun 7.1.26)
function _phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  let p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}
// A small fixed quadrature over Normal(mean,sd), increments clamped at 0. Returns [{x, w}].
function _normNodes(mean, sd) {
  if (!(sd > 0.01)) return [{ x: Math.max(0, mean), w: 1 }];
  const pts = [-1.6, -0.8, 0, 0.8, 1.6];                 // weights ≈ a 5-point Gauss-Hermite-ish grid
  const ws = [0.1123, 0.2393, 0.2967, 0.2393, 0.1123];
  return pts.map((z, i) => ({ x: Math.max(0, mean + z * sd), w: ws[i] }));
}

/* ---------- heads-up exact dynamic program ---------- */
// WP table: _huTable[deal][a][b] = P(YOU win) when you need `a`, opp needs `b`, and `deal` (0=you
// deal this hand, 1=opp deals). Built once. All non-(0,0) hand outcomes drop a+b, so we fill by
// increasing total; the (0,0) "both score nothing" self-loop between the two deal parities is
// resolved in closed form at each (a,b).
let _huTable = null;
function _buildHeadsUp() {
  const T = WP_TARGET(2);                                 // 121
  const dPmf = WINPROB_STATS.headsUp.dealer.pmf, pPmf = WINPROB_STATS.headsUp.pone.pmf;
  if (!dPmf.length || !pPmf.length) { _huTable = false; return; } // stats not baked yet → analytic fallback
  // tail sums: tail(pmf, k) = P(score >= k)
  const tailOf = (pmf) => { const c = new Array(pmf.length + 1).fill(0); for (let i = pmf.length - 1; i >= 0; i--) c[i] = c[i + 1] + pmf[i]; return c; };
  const dTail = tailOf(dPmf), pTail = tailOf(pPmf);
  const tail = (t, k) => (k <= 0 ? 1 : k >= t.length ? 0 : t[k]);
  // WP[deal] is a (T+1) x (T+1) grid (index by a,b in 0..T). a<=0 ⇒ you already won (1); b<=0 ⇒ lost (0).
  const WP = [new Array((T + 1) * (T + 1)).fill(0), new Array((T + 1) * (T + 1)).fill(0)];
  const get = (deal, a, b) => (a <= 0 ? 1 : b <= 0 ? 0 : WP[deal][a * (T + 1) + b]);
  // when both cross in the same hand, the PONE (non-dealer) counts/pegs out first → pone wins the tie
  for (let s = 2; s <= 2 * T; s++) {
    for (let a = Math.max(1, s - T); a <= Math.min(T, s - 1); a++) {
      const b = s - a; if (b < 1 || b > T) continue;
      // R(deal): hand outcome value excluding the (0,0) self-loop term.
      const R = [0, 0];
      for (let deal = 0; deal < 2; deal++) {
        const yPmf = deal === 0 ? dPmf : pPmf;            // your increment dist this hand
        const oPmf = deal === 0 ? pPmf : dPmf;            // opp increment dist
        const yTail = deal === 0 ? dTail : pTail, oTail = deal === 0 ? pTail : dTail;
        const youAreDealer = deal === 0;
        let acc = 0;
        // both cross → tie: pone wins. you win the tie iff you're the pone (opp deals).
        acc += tail(yTail, a) * tail(oTail, b) * (youAreDealer ? 0 : 1);
        // only you cross → you win
        acc += tail(yTail, a) * (1 - tail(oTail, b)) * 1;
        // only opp crosses → 0 (omitted). neither crosses → recurse (strictly smaller a+b, except (0,0)).
        for (let di = 0; di < a && di < yPmf.length; di++) {
          const py = yPmf[di]; if (!py) continue;
          for (let doo = 0; doo < b && doo < oPmf.length; doo++) {
            if (di === 0 && doo === 0) continue;          // self-loop handled below
            const po = oPmf[doo]; if (!po) continue;
            acc += py * po * get(1 - deal, a - di, b - doo);
          }
        }
        R[deal] = acc;
      }
      // self-loop: x = m·y + R0, y = m·x + R1, with m = P(both score 0) (same for both parities).
      const m = dPmf[0] * pPmf[0];
      const denom = 1 - m * m;
      WP[0][a * (T + 1) + b] = (R[0] + m * R[1]) / denom;
      WP[1][a * (T + 1) + b] = (R[1] + m * R[0]) / denom;
    }
  }
  _huTable = { T, WP, get };
}
function _wpHeadsUp(yourToGo, oppToGo, youDeal) {
  if (_huTable === null) _buildHeadsUp();
  if (!_huTable) return null;                             // not baked → caller uses analytic
  const a = Math.max(0, Math.round(yourToGo)), b = Math.max(0, Math.round(oppToGo));
  return _huTable.get(youDeal ? 0 : 1, a, b);
}

/* ---------- analytic normal-approximation race (general configs) ---------- */
// Model "hands to reach the target" for each side as ~Normal (renewal/Wald: accumulating `g`
// points at mean μ, var σ² per hand takes ≈ g/μ hands with variance ≈ g·σ²/μ³). You win if you
// get there in fewer hands: P ≈ Φ((n_opp − n_you)/√(v_you + v_opp)).
function _wpRace(yourToGo, oppToGo, youDeal, P, teams) {
  const g = WINPROB_STATS.general[`${P}-${teams}`] || WINPROB_STATS.general[`${P}-${P}`] || WINPROB_STATS.general["4-4"];
  // average a side's per-hand mean/var over the deal rotation (each side deals 1/teams of the time);
  // the next-hand deal parity is handled by the `edge` term below
  const muY = (g.deal.mean + (teams - 1) * g.def.mean) / teams;
  const vaY = (g.deal.var + (teams - 1) * g.def.var) / teams;
  const a = Math.max(0.5, yourToGo), b = Math.max(0.5, oppToGo);
  const nY = a / muY, nO = b / muY;                       // both sides share the same long-run rate
  const vY = a * vaY / (muY * muY * muY), vO = b * vaY / (muY * muY * muY);
  // a small edge to whoever deals next (the dealer side scores more that hand)
  const edge = (youDeal ? 1 : -1) * (g.deal.mean - muY) / muY;
  const z = (nO - nY + edge) / Math.sqrt(Math.max(1e-6, vY + vO));
  return _phi(z);
}

/* ---------- public: current win-prob from a board ---------- */
// board = { yourToGo, oppToGo, youDeal, P, teams }
function winProb(board) {
  if (board.yourToGo <= 0) return 1;
  if (board.oppToGo <= 0) return 0;
  if (board.P === 2) { const w = _wpHeadsUp(board.yourToGo, board.oppToGo, board.youDeal); if (w !== null) return w; }
  return _wpRace(board.yourToGo, board.oppToGo, board.youDeal, board.P, board.teams);
}

const WP_AVG_CRIB = 4.7;   // mean crib value; only sets the opp baseline — option signal is exact
// opponent's expected per-hand increment EXCLUDING the part your discard controls (your crib gift,
// which the caller passes as oppAdd). When you deal, the opp is the pone; when you're the pone, the
// opp is the dealer and we subtract the average crib so oppAdd reconstructs it.
function _oppBase(board) {
  if (board.P === 2) {
    return board.youDeal ? WINPROB_STATS.headsUp.pone.mean
      : WINPROB_STATS.headsUp.dealer.mean - WP_AVG_CRIB;
  }
  const g = WINPROB_STATS.general[`${board.P}-${board.teams}`] || WINPROB_STATS.general[`${board.P}-${board.P}`];
  return board.youDeal ? g.def.mean : g.deal.mean - WP_AVG_CRIB;
}

/* ---------- public: rank a discard by E[win-prob] after this hand ---------- */
// board: the pre-hand state. (mean,sd): YOUR side's increment this hand (already including your own
// crib if you deal). oppAdd: extra points your throw gifts the opponent (your crib if you're pone).
// Next hand the deal rotates, so we recurse into the opponent's-deal layer.
function winProbHand(board, mean, sd, oppAdd) {
  const oppInc = _oppBase(board) + (oppAdd || 0);
  const next = { yourToGo: 0, oppToGo: board.oppToGo - oppInc, youDeal: !board.youDeal, P: board.P, teams: board.teams };
  let acc = 0;
  for (const { x, w } of _normNodes(mean, sd)) {
    const a2 = board.yourToGo - x, b2 = board.oppToGo - oppInc;
    let v;
    if (a2 <= 0) v = (b2 <= 0 && board.youDeal) ? 0 : 1;  // you reach target; lose the tie only if you're the dealer
    else if (b2 <= 0) v = 0;
    else { next.yourToGo = a2; next.oppToGo = b2; v = winProb(next); }
    acc += w * v;
  }
  return acc;
}
