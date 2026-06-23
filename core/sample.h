// sample.h — one AlphaZero training example produced by self-play.
#pragma once
#include "game.h"
#include <vector>

namespace cz {

struct Sample {
  std::vector<float> x;      // encoded state (INPUT_DIM)
  std::vector<float> pi;     // MCTS visit distribution over slots (NPOL)
  std::vector<bool> legal;   // legal slot mask (NPOL)
  double z;                  // game outcome from the acting player's view (+1 win / -1 loss)
};

} // namespace cz
