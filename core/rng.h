// rng.h — mulberry32 PRNG (ports engine/az_common.js makeRng): deterministic, fast, uint32 state.
#pragma once
#include <cstdint>

namespace cz {

struct Rng {
  uint32_t a;
  explicit Rng(uint32_t seed) : a(seed) {}

  // returns a double in [0,1), bit-for-bit the same sequence as the JS mulberry32 for a given seed.
  double next() {
    a += 0x6d2b79f5u;
    uint32_t t = a;
    t = (t ^ (t >> 15)) * (1u | t);
    t = (t + ((t ^ (t >> 7)) * (61u | t))) ^ t;
    return double((t ^ (t >> 14)) >> 0) / 4294967296.0;
  }

  // uniform integer in [0, n)
  int below(int n) { return int(next() * n); }
};

} // namespace cz
