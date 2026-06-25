// sample.h — one AlphaZero training example produced by self-play.
#pragma once
#include "game.h"
#include <vector>
#include <cmath>

namespace cz {

struct Sample {
  std::vector<float> x;      // encoded state (INPUT_DIM)
  std::vector<float> pi;     // MCTS visit distribution over slots (NPOL)
  std::vector<bool> legal;   // legal slot mask (NPOL)
  double z;                  // game outcome from the acting player's view (+1 win / -1 loss)
};

// Reject samples that could poison training. The bus is internet-facing — a buggy/hostile actor (or a bit-flip)
// could upload a sample with a non-finite or absurd value, and one such sample backprops into a huge gradient
// that NaNs the whole net. Good encodings keep x in [0,1] (one-hots + normalized), pi a distribution, z = ±1.
inline bool sampleFinite(const Sample& s) {
  for (float v : s.x) if (!std::isfinite(v) || v < -4.0f || v > 4.0f) return false;
  for (float v : s.pi) if (!std::isfinite(v) || v < -0.01f || v > 1.01f) return false;
  if (!std::isfinite(s.z) || s.z < -1.5 || s.z > 1.5) return false;
  return true;
}

} // namespace cz
