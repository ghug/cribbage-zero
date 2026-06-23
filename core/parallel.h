// parallel.h — threaded self-play. The net is read-only during self-play (forward() is const), so all worker
// threads share one net; each thread owns its Mcts + search RNG. Work is nPairs antithetic match-pairs.
#pragma once
#include "selfplay.h"
#include <thread>
#include <mutex>
#include <atomic>
#include <algorithm>

namespace cz {

inline long parallelSelfPlay(const Net& net, int sims, double cpuct, int nPairs, int nThreads,
                             uint32_t baseSeed, std::vector<Sample>& out,
                             int tempMoves = 30, double dirEps = 0.25, double dirAlpha = 0.8,
                             double fpu = 0.25, double cBase = 19652.0) {
  std::mutex mtx;
  std::atomic<int> nextPair{0};
  std::atomic<long> games{0};
  auto worker = [&](int tid) {
    Mcts mcts;
    Rng searchRng(baseSeed ^ (0x9e3779b9u * (uint32_t)(tid + 1)));
    std::vector<Sample> local;
    int p;
    while ((p = nextPair.fetch_add(1)) < nPairs) {
      uint32_t pairSeed = baseSeed * 2654435761u + (uint32_t)p * 40503u + 1u;
      if (playMatchPair(net, sims, cpuct, pairSeed, searchRng, mcts, local, tempMoves, dirEps, dirAlpha, fpu, cBase)) games += 2;
    }
    std::lock_guard<std::mutex> lk(mtx);
    for (auto& s : local) out.push_back(std::move(s));
  };
  std::vector<std::thread> ths;
  int n = std::max(1, nThreads);
  for (int t = 0; t < n; t++) ths.emplace_back(worker, t);
  for (auto& t : ths) t.join();
  return games.load();
}

} // namespace cz
