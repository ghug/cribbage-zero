// eval.h — native net evaluation, the C++ twin of engine/eval_zero.js. ANTITHETIC like the JS path: each deal
// is played twice with the net on opposite seats (same deal-RNG seed), so deal luck cancels and `pairs` -> 2*pairs
// games. The net plays its raw greedy policy (argmax over legal logits). Two opponents: a uniform-random player
// (evalVsRandom) and the vendored hard bot (evalVsHard, hardbot.h). `onProgress(frac)` is called periodically.
#pragma once
#include "game.h"
#include "net.h"
#include "hardbot.h"
#include "rng.h"
#include <vector>
#include <functional>
#include <cstdint>

namespace cz {

inline int argmaxLegal(const std::vector<float>& logits, const std::vector<bool>& legal) {
  int m = -1; double b = -1e300;
  for (int s = 0; s < (int)logits.size(); s++) if (legal[s] && logits[s] > b) { b = logits[s]; m = s; }
  return m;
}

using ProgFn = std::function<void(double)>;

inline double evalVsRandom(const Net& net, long pairs, Rng& rng, const ProgFn& prog = nullptr) {
  long wins = 0;
  for (long pi = 0; pi < pairs; pi++) {
    uint32_t dealSeed = (uint32_t)(rng.next() * 4294967296.0);
    for (int half = 0; half < 2; half++) {
      Rng dealRng(dealSeed);
      Rng moveRng((uint32_t)(dealSeed ^ (uint32_t)(0x9e3779b9u * (half + 1))));
      CribGame g(dealRng, 0); int netSeat = half, guard = 0;
      while (!g.done && guard++ < 4000) {
        int p = g.toAct; auto legal = g.legalSlots();
        int mv;
        if (p == netSeat) { mv = argmaxLegal(net.forward(g.encode(p)).logits, legal); }
        else { std::vector<int> ls; for (int s = 0; s < NPOL; s++) if (legal[s]) ls.push_back(s); mv = ls[(int)(moveRng.next() * ls.size())]; }
        g.step(mv, dealRng);
      }
      if (g.winner == netSeat) wins++;
    }
    if (prog && (pi % 100 == 0)) prog((double)pi / pairs);
  }
  return (double)wins / (double)(pairs * 2);
}

inline double evalVsHard(const Net& net, long pairs, Rng& rng, const ProgFn& prog = nullptr) {
  long wins = 0;
  for (long pi = 0; pi < pairs; pi++) {
    uint32_t dealSeed = (uint32_t)(rng.next() * 4294967296.0);
    for (int half = 0; half < 2; half++) {                 // hard bot + greedy net are deterministic — only the deal seed is shared
      Rng dealRng(dealSeed);
      CribGame g(dealRng, 0); int netSeat = half, guard = 0;
      while (!g.done && guard++ < 4000) {
        int p = g.toAct; auto legal = g.legalSlots();
        int mv = (p == netSeat) ? argmaxLegal(net.forward(g.encode(p)).logits, legal) : hardSlot(g, p);
        g.step(mv, dealRng);
      }
      if (g.winner == netSeat) wins++;
    }
    if (prog && (pi % 100 == 0)) prog((double)pi / pairs);
  }
  return (double)wins / (double)(pairs * 2);
}

} // namespace cz
