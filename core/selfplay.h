// selfplay.h — AlphaZero self-play with MATCH-LEVEL ANTITHETIC pairing.
// A unit of self-play is a PAIR of full games to 121 that share the same deal stream (same shuffle per hand,
// in order) but with the initial dealer swapped — so each seat plays both sides of every deal and deals once,
// cancelling the deal/first-dealer luck in the value targets. The deal RNG is seeded identically for the two
// games and kept SEPARATE from the search RNG (so MCTS's hypothetical determinizations never desync or leak
// the real deal stream). If the mirror runs more hands than the first game, it draws genuinely new shuffles
// from the same deterministic stream.
#pragma once
#include "game.h"
#include "net.h"
#include "mcts.h"
#include "sample.h"
#include <vector>

namespace cz {

// play one full game to 121; append a sample per decision (z filled from the final outcome). Returns true if
// the game terminated cleanly. `dealRng` advances the real deals; `searchRng` drives MCTS only.
inline bool playOneGame(CribGame& game, const Net& net, int sims, double cPuct,
                        Rng& dealRng, Rng& searchRng, Mcts& mcts, std::vector<Sample>& out,
                        int tempMoves = 0, double dirEps = 0.0, double dirAlpha = 0.8,
                        double fpu = 0.0, double cBase = 0.0) {
  struct Step { std::vector<float> x, pi; std::vector<bool> legal; int player; };
  std::vector<Step> traj;
  int guard = 0, ply = 0;
  while (!game.done && guard++ < 20000) {
    int player = game.toAct;
    SearchResult r = mcts.search(game, net, sims, cPuct, searchRng, dirEps, dirAlpha, fpu, cBase);
    auto legal = game.legalSlots();
    std::vector<float> pi(r.policy.begin(), r.policy.end());
    traj.push_back({game.encode(player), std::move(pi), std::move(legal), player});
    // move selection: sample ∝ the visit distribution for the first tempMoves plies (τ=1), else argmax.
    // Uses searchRng (NOT dealRng) so the antithetic deal stream stays in sync across the mirrored pair.
    int move = r.move;
    if (ply < tempMoves) {
      double u = searchRng.next(), c = 0;
      for (int s = 0; s < NPOL; s++) { c += r.policy[s]; if (u <= c) { move = s; break; } }
    }
    game.step(move, dealRng);
    ply++;
  }
  if (!game.done) return false;
  for (auto& s : traj) {
    double z = (game.winner == s.player) ? 1.0 : -1.0;
    out.push_back({std::move(s.x), std::move(s.pi), std::move(s.legal), z});
  }
  return true;
}

// one antithetic pair: same deal seed, opposite initial dealer. Returns true if both games terminated.
inline bool playMatchPair(const Net& net, int sims, double cPuct, uint32_t pairSeed,
                          Rng& searchRng, Mcts& mcts, std::vector<Sample>& out,
                          int tempMoves = 0, double dirEps = 0.0, double dirAlpha = 0.8,
                          double fpu = 0.0, double cBase = 0.0) {
  Rng dealA(pairSeed); CribGame ga(dealA, /*initialDealer=*/0);
  bool okA = playOneGame(ga, net, sims, cPuct, dealA, searchRng, mcts, out, tempMoves, dirEps, dirAlpha, fpu, cBase);
  Rng dealB(pairSeed); CribGame gb(dealB, /*initialDealer=*/1);
  bool okB = playOneGame(gb, net, sims, cPuct, dealB, searchRng, mcts, out, tempMoves, dirEps, dirAlpha, fpu, cBase);
  return okA && okB;
}

} // namespace cz
