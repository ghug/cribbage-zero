// hardbot.h — the vendored "hard bot" heuristic, ported from src/winprob.js + src/engine.js + engine/eval_zero.js
// so the native engine can run the SAME vs-hard eval as the JS path. Pure C++ on CribGame (game.h) + scoring.h.
//   winProbHand(board, mean, sd, oppAdd) — the win-probability board model (heads-up exact DP + analytic race)
//   handDetail(four, dealt)              — exact hand-EV over all unseen cuts (ev, sd)
//   pegChooseDeep(...)                   — depth-1 expectimax pegging
//   hardSlot(game, player)              — the bot's chosen policy slot from a CribGame info-set
// The baked WINPROB_STATS are transcribed (via a generator) from engine/winprob_stats.json — regenerate
// alongside src/winprob.js if the bots' play changes. Validated numerically against the JS in test_hardbot.cpp.
#pragma once
#include "game.h"
#include "scoring.h"
#include "cards.h"
#include "rng.h"
#include <vector>
#include <map>
#include <string>
#include <cmath>
#include <algorithm>
#include <cstdint>

namespace cz {

struct WpBoard { double yourToGo, oppToGo; bool youDeal; int P, teams; };

// ===== baked self-play increment stats (mirror src/winprob.js WINPROB_STATS) =====
inline double huDealerMean() { return 16.653; }
inline double huPoneMean() { return 10.7934; }
inline const std::vector<double>& huDealerPmf() {
  static const std::vector<double> v = { 0, 0, 0.00005, 0.0009, 0.00125, 0.0045, 0.00735, 0.01505, 0.0174, 0.032, 0.0373, 0.05545, 0.05615, 0.0724, 0.0725, 0.07815, 0.0719, 0.07175, 0.0669, 0.0607, 0.05205, 0.04855, 0.0374, 0.0303, 0.02715, 0.02065, 0.0164, 0.01265, 0.00855, 0.0069, 0.00485, 0.0031, 0.00285, 0.0019, 0.0017, 0.00095, 0.0006, 0.00065, 0.0002, 0.00015, 0.00015, 0.00015, 0.00005, 0.00025, 0.0001, 0, 0, 0, 0, 0, 0, 0, 0.00005 };
  return v;
}
inline const std::vector<double>& huPonePmf() {
  static const std::vector<double> v = { 0.00055, 0.0013, 0.0069, 0.0179, 0.03205, 0.0549, 0.05635, 0.08315, 0.0794, 0.1104, 0.08715, 0.0824, 0.0721, 0.07245, 0.04535, 0.04635, 0.0338, 0.0301, 0.0241, 0.0163, 0.0125, 0.00875, 0.0071, 0.0051, 0.00445, 0.0031, 0.00185, 0.00085, 0.0011, 0.0005, 0.00035, 0.00065, 0.00035, 0.00015, 0.00005, 0.00005, 0.00005, 0, 0.00005 };
  return v;
}
struct GenCfg { int target; double dMean, dVar, fMean, fVar; };
inline const std::map<std::string, GenCfg>& genCfg() {
  static const std::map<std::string, GenCfg> g = {
    {"2-2", {121, 16.795, 29.066, 10.832, 21.986}}, {"3-3", {121, 15.213, 30.044, 9.312, 19.405}},
    {"4-4", {121, 14.899, 31.521, 9.756, 19.827}},  {"4-2", {121, 25.155, 48.978, 19.53, 39.66}},
    {"5-5", {61, 12.866, 28.343, 9.935, 20.021}},   {"6-6", {61, 13.217, 29.698, 9.685, 20.321}},
    {"6-3", {61, 23.629, 53.475, 18.951, 39.862}},  {"6-2", {61, 33.413, 67.002, 28.146, 57.098}},
  };
  return g;
}
inline int wpTarget(int P) { return P >= 5 ? 61 : 121; }

// standard normal CDF (Abramowitz-Stegun 7.1.26)
inline double wpPhi(double z) {
  double t = 1.0 / (1.0 + 0.2316419 * std::fabs(z));
  double d = 0.3989422804014327 * std::exp(-z * z / 2);
  double p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}
struct WpNode { double x, w; };
inline std::vector<WpNode> wpNormNodes(double mean, double sd) {
  if (!(sd > 0.01)) return { {std::max(0.0, mean), 1.0} };
  static const double pts[5] = {-1.6, -0.8, 0, 0.8, 1.6};
  static const double ws[5] = {0.1123, 0.2393, 0.2967, 0.2393, 0.1123};
  std::vector<WpNode> out(5);
  for (int i = 0; i < 5; i++) out[i] = { std::max(0.0, mean + pts[i] * sd), ws[i] };
  return out;
}

// ---- heads-up exact dynamic program (built once) ----
struct HuTable {
  int T = 0;
  std::vector<double> WP0, WP1;
  double get(int deal, int a, int b) const {
    if (a <= 0) return 1.0;
    if (b <= 0) return 0.0;
    return (deal == 0 ? WP0 : WP1)[(size_t)a * (T + 1) + b];
  }
};
inline HuTable buildHu() {
  const int T = wpTarget(2);
  const auto& dPmf = huDealerPmf();
  const auto& pPmf = huPonePmf();
  auto tailOf = [](const std::vector<double>& pmf) {
    std::vector<double> c(pmf.size() + 1, 0.0);
    for (int i = (int)pmf.size() - 1; i >= 0; i--) c[i] = c[i + 1] + pmf[i];
    return c;
  };
  std::vector<double> dTail = tailOf(dPmf), pTail = tailOf(pPmf);
  auto tail = [](const std::vector<double>& t, int k) { return k <= 0 ? 1.0 : (k >= (int)t.size() ? 0.0 : t[k]); };
  HuTable H; H.T = T;
  H.WP0.assign((size_t)(T + 1) * (T + 1), 0.0);
  H.WP1.assign((size_t)(T + 1) * (T + 1), 0.0);
  auto get = [&](int deal, int a, int b) -> double {
    if (a <= 0) return 1.0; if (b <= 0) return 0.0;
    return (deal == 0 ? H.WP0 : H.WP1)[(size_t)a * (T + 1) + b];
  };
  const double m = dPmf[0] * pPmf[0], denom = 1 - m * m;
  for (int s = 2; s <= 2 * T; s++) {
    for (int a = std::max(1, s - T); a <= std::min(T, s - 1); a++) {
      int b = s - a; if (b < 1 || b > T) continue;
      double R[2] = {0, 0};
      for (int deal = 0; deal < 2; deal++) {
        const auto& yPmf = deal == 0 ? dPmf : pPmf;
        const auto& oPmf = deal == 0 ? pPmf : dPmf;
        const auto& yTail = deal == 0 ? dTail : pTail;
        const auto& oTail = deal == 0 ? pTail : dTail;
        bool youAreDealer = (deal == 0);
        double acc = tail(yTail, a) * tail(oTail, b) * (youAreDealer ? 0.0 : 1.0);
        acc += tail(yTail, a) * (1 - tail(oTail, b)) * 1.0;
        for (int di = 0; di < a && di < (int)yPmf.size(); di++) {
          double py = yPmf[di]; if (!py) continue;
          for (int doo = 0; doo < b && doo < (int)oPmf.size(); doo++) {
            if (di == 0 && doo == 0) continue;
            double po = oPmf[doo]; if (!po) continue;
            acc += py * po * get(1 - deal, a - di, b - doo);
          }
        }
        R[deal] = acc;
      }
      H.WP0[(size_t)a * (T + 1) + b] = (R[0] + m * R[1]) / denom;
      H.WP1[(size_t)a * (T + 1) + b] = (R[1] + m * R[0]) / denom;
    }
  }
  return H;
}
inline const HuTable& huTable() { static const HuTable H = buildHu(); return H; }
inline double wpHeadsUp(double yourToGo, double oppToGo, bool youDeal) {
  int a = std::max(0, (int)std::lround(yourToGo)), b = std::max(0, (int)std::lround(oppToGo));
  return huTable().get(youDeal ? 0 : 1, a, b);
}

// ---- analytic normal-approximation race (general configs) ----
inline double wpRace(double yourToGo, double oppToGo, bool youDeal, int P, int teams) {
  auto key = std::to_string(P) + "-" + std::to_string(teams);
  const auto& G = genCfg();
  auto it = G.find(key); if (it == G.end()) it = G.find(std::to_string(P) + "-" + std::to_string(P));
  if (it == G.end()) it = G.find("4-4");
  const GenCfg& g = it->second;
  double muY = (g.dMean + (teams - 1) * g.fMean) / teams;
  double vaY = (g.dVar + (teams - 1) * g.fVar) / teams;
  double a = std::max(0.5, yourToGo), b = std::max(0.5, oppToGo);
  double nY = a / muY, nO = b / muY;
  double vY = a * vaY / (muY * muY * muY), vO = b * vaY / (muY * muY * muY);
  double edge = (youDeal ? 1.0 : -1.0) * (g.dMean - muY) / muY;
  double z = (nO - nY + edge) / std::sqrt(std::max(1e-6, vY + vO));
  return wpPhi(z);
}
inline double winProb(const WpBoard& b) {
  if (b.yourToGo <= 0) return 1;
  if (b.oppToGo <= 0) return 0;
  if (b.P == 2) return wpHeadsUp(b.yourToGo, b.oppToGo, b.youDeal);
  return wpRace(b.yourToGo, b.oppToGo, b.youDeal, b.P, b.teams);
}
inline double wpOppBase(const WpBoard& b) {
  const double WP_AVG_CRIB = 4.7;
  if (b.P == 2) return b.youDeal ? huPoneMean() : (huDealerMean() - WP_AVG_CRIB);
  auto key = std::to_string(b.P) + "-" + std::to_string(b.teams);
  const auto& G = genCfg();
  auto it = G.find(key); if (it == G.end()) it = G.find(std::to_string(b.P) + "-" + std::to_string(b.P));
  const GenCfg& g = it->second;
  return b.youDeal ? g.fMean : g.dMean - WP_AVG_CRIB;
}
// rank a discard by E[win-prob] after this hand (mirrors winProbHand in src/winprob.js)
inline double winProbHand(const WpBoard& board, double mean, double sd, double oppAdd) {
  double oppInc = wpOppBase(board) + oppAdd;
  double acc = 0;
  for (const auto& nd : wpNormNodes(mean, sd)) {
    double a2 = board.yourToGo - nd.x, b2 = board.oppToGo - oppInc;
    double v;
    if (a2 <= 0) v = (b2 <= 0 && board.youDeal) ? 0.0 : 1.0;
    else if (b2 <= 0) v = 0.0;
    else { WpBoard nx{a2, b2, !board.youDeal, board.P, board.teams}; v = winProb(nx); }
    acc += nd.w * v;
  }
  return acc;
}

// ===== hand EV (exact over unseen cuts) + crib seed + deep pegging =====
struct HandEv { double ev, sd; };
inline HandEv handDetail(const Card four[4], const std::vector<Card>& dealt) {
  uint8_t seen[52] = {0};
  for (const auto& c : dealt) seen[cardId(c)] = 1;
  double total = 0, sq = 0; int n = 0;
  for (int r = 1; r <= 13; r++) for (int s = 0; s < 4; s++) {
    Card st{r, s}; if (seen[cardId(st)]) continue;
    int t = scoreInto(four, st, false, nullptr);
    total += t; sq += (double)t * t; n++;
  }
  double ev = total / n, var = std::max(0.0, sq / n - ev * ev);
  return { ev, std::sqrt(var) };
}
inline const double* cribValueTable() {
  static const double v[13] = {3.96, 3.95, 4.05, 4.06, 6.38, 4.10, 4.21, 4.34, 4.09, 3.74, 4.19, 3.73, 3.85};
  return v;
}
inline double cribSeed(const Card& a, const Card& b) {
  double v = (cribValueTable()[a.r - 1] + cribValueTable()[b.r - 1]) * 0.5;
  if (a.r == b.r) v += 2; else if (std::abs(a.r - b.r) <= 2) v += 0.5;
  auto fif = [](int r) { return std::min(r, 10); };
  if (fif(a.r) + fif(b.r) == 15) v += 2;
  return v;
}
// depth-1 expectimax pegging (ports pegChooseDeep). All args are ranks 1..13.
inline int pegChooseDeep(const std::vector<int>& legal, int count, const std::vector<int>& pile,
                         const std::vector<int>& hand, const std::vector<int>& unseen) {
  int avail[14] = {0};
  for (int r : unseen) avail[r]++;
  int tot = (int)unseen.size();
  int best = legal.empty() ? -1 : legal[0]; double bestKey = -1e9;
  for (int c : legal) {
    int nc = count + pval(c);
    std::vector<int> p1 = pile; p1.push_back(c);
    double myGain = pegScore(p1, nc);
    double threat = 0; bool oppCanPlay = false;
    if (nc != 31) {
      double num = 0;
      for (int r = 1; r <= 13; r++) if (avail[r] && pval(r) + nc <= 31) {
        std::vector<int> p2 = p1; p2.push_back(r);
        num += avail[r] * (double)pegScore(p2, nc + pval(r)); oppCanPlay = true;
      }
      threat = tot > 0 ? num / tot : 0;
    }
    double key = myGain * 10 - 1.0 * threat * 10;
    if (nc != 31 && !oppCanPlay) key += 1;
    if (nc == 5 || nc == 21) key -= 2;
    if (count == 0) { if (c == 5) key -= 2; key -= pval(c) * 0.1; int cnt = 0; for (int x : hand) if (x == c) cnt++; if (cnt >= 2) key += 0.5; }
    else key -= pval(c) * 0.02;
    if (key > bestKey) { bestKey = key; best = c; }
  }
  return best;
}

// ===== the hard bot: a CribGame info-set -> a policy slot (ports eval_zero.js hardSlot) =====
inline int hardSlot(const CribGame& g, int player) {
  if (g.phase == 0) {                                   // discard: pick the best of the 15 throws
    const std::vector<Card>& dealt = g.six[player];
    bool cribOurs = (g.dealer == player);
    WpBoard board{ (double)(TARGET - g.scores[player]), (double)(TARGET - g.scores[1 - player]), cribOurs, 2, 2 };
    int best = 0; double bv = -1e9;
    for (int s = 0; s < NPOL; s++) {
      auto pr = combos6()[s]; int i = pr.first, j = pr.second;
      Card four[4]; int n = 0;
      for (int t = 0; t < 6; t++) if (t != i && t != j) four[n++] = dealt[t];
      double cv = cribSeed(dealt[i], dealt[j]);
      HandEv hd = handDetail(four, dealt);
      double v = winProbHand(board, hd.ev + (cribOurs ? cv : 0.0), hd.sd, cribOurs ? 0.0 : cv);
      if (v > bv) { bv = v; best = s; }
    }
    return best;
  }
  // pegging: choose the card via depth-1 expectimax over the unseen pool
  const std::vector<Card>& hand = g.pegHand[player];
  int count = g.count;
  const std::vector<Card>& kept = g.kept[player];
  int acct[14] = {0};
  for (const auto& c : hand) acct[c.r]++;
  for (const auto& c : g.six[player]) {                 // my discards = dealt six minus kept
    bool inKept = false; for (const auto& kc : kept) if (kc == c) { inKept = true; break; }
    if (!inKept) acct[c.r]++;
  }
  if (g.hasStarter) acct[g.starter.r]++;
  for (const auto& c : g.playedSuited) acct[c.r]++;
  std::vector<int> unseen;
  for (int r = 1; r <= 13; r++) { int a = 4 - acct[r]; for (int k = 0; k < a; k++) unseen.push_back(r); }
  std::vector<int> legalR, handR;
  for (const auto& c : hand) { handR.push_back(c.r); if (pval(c.r) + count <= 31) legalR.push_back(c.r); }
  int cr = pegChooseDeep(legalR, count, g.pile, handR, unseen);
  for (int s = 0; s < (int)hand.size(); s++) if (hand[s].r == cr && pval(hand[s].r) + count <= 31) return s;
  auto legal = g.legalSlots();
  for (int s = 0; s < NPOL; s++) if (legal[s]) return s;
  return 0;
}

} // namespace cz
