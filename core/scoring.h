// scoring.h — cribbage scoring, ported faithfully from src/engine.js (scoreInto, pegScore).
// The show: 4 kept cards + starter, scored for fifteens / pairs / runs / flush / nobs.
// Pegging: the running pile (ranks only) scored for 15 / 31 / pairs / runs / (go & last-card live in the game).
#pragma once
#include "cards.h"
#include <algorithm>

namespace cz {

struct Cats { int fifteen = 0, pair = 0, run = 0, flush = 0, nobs = 0; };

// score a 5-card show (four kept + starter). isCrib gates the 4-card flush. Adds category breakdown to *acc.
inline int scoreInto(const Card four[4], const Card& starter, bool isCrib, Cats* acc = nullptr) {
  Card all[5] = {four[0], four[1], four[2], four[3], starter};
  int f = 0, p = 0, ru = 0, fl = 0, no = 0;
  // fifteens: every non-empty subset of the 5 whose pip-sum is 15 → 2 pts
  for (int m = 1; m < 32; m++) {
    int s = 0;
    for (int i = 0; i < 5; i++) if (m & (1 << i)) s += pval(all[i].r);
    if (s == 15) f += 2;
  }
  // pairs
  for (int i = 0; i < 5; i++)
    for (int j = i + 1; j < 5; j++) if (all[i].r == all[j].r) p += 2;
  // runs (with duplicate multipliers): each maximal consecutive block of length ≥3 scores len*product-of-counts
  int c[14] = {0};
  for (int i = 0; i < 5; i++) c[all[i].r]++;
  int r = 1;
  while (r <= 13) {
    if (!c[r]) { r++; continue; }
    int len = 0, pr = 1, rr = r;
    while (rr <= 13 && c[rr] > 0) { len++; pr *= c[rr]; rr++; }
    if (len >= 3) ru += len * pr;
    r = rr;
  }
  // flush: 4 kept same suit → 4 (5 if starter matches); a crib needs all 5 to count
  int s0 = four[0].s;
  bool allSame = four[0].s == s0 && four[1].s == s0 && four[2].s == s0 && four[3].s == s0;
  if (allSame) {
    if (starter.s == s0) fl += 5;
    else if (!isCrib) fl += 4;
  }
  // nobs: a kept jack matching the starter's suit
  for (int i = 0; i < 4; i++) if (four[i].r == 11 && four[i].s == starter.s) no += 1;
  if (acc) { acc->fifteen += f; acc->pair += p; acc->run += ru; acc->flush += fl; acc->nobs += no; }
  return f + p + ru + fl + no;
}

// pegging points for the most recent play. `pile` holds the ranks laid since the last reset; `count` is the
// running pip total. (Go and last-card are scored by the game, not here.)
inline int pegScore(const std::vector<int>& pile, int count) {
  int pts = 0;
  if (count == 15) pts += 2;
  if (count == 31) pts += 2;
  int n = (int)pile.size();
  if (n == 0) return pts;
  int last = pile[n - 1];
  // pair / pair-royal / double-pair-royal: k equal cards at the tail → k*(k-1)
  int k = 1;
  for (int i = n - 2; i >= 0; i--) { if (pile[i] == last) k++; else break; }
  if (k >= 2) pts += k * (k - 1);
  // runs: longest tail (len 3..7) that is a set of consecutive ranks
  for (int m = std::min(n, 7); m >= 3; m--) {
    int mn = 99, mx = -1;
    bool seen[14] = {false};
    bool dup = false;
    for (int i = n - m; i < n; i++) {
      int v = pile[i];
      if (v >= 1 && v <= 13) { if (seen[v]) dup = true; seen[v] = true; }
      mn = std::min(mn, v); mx = std::max(mx, v);
    }
    if (!dup && (mx - mn) == m - 1) { pts += m; break; }
  }
  return pts;
}

} // namespace cz
