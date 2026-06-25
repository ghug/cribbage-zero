// test_guards.cpp — the anti-NaN guards: sample validation (sampleFinite / ReplayBuffer drop), net.finite()
// (refuse to push a poisoned net), and clampWeights() (bound the unbounded-ReLU runaway).
#include "../sample.h"
#include "../buffer.h"
#include "../net.h"
#include "../game.h"
#include <cstdio>
#include <cmath>
#include <vector>

using namespace cz;
static int ok = 0, fail = 0;
static void check(bool c, const char* m) { if (c) ok++; else { fail++; std::printf("  x %s\n", m); } }

static Sample goodSample() {
  Sample s; s.x.assign(INPUT_DIM, 0.0f); s.x[0] = 1.0f;        // a one-hot-ish input in range
  s.pi.assign(NPOL, 0.0f); s.pi[0] = 1.0f; s.legal.assign(NPOL, true); s.z = 1.0; return s;
}

int main() {
  // 1) sampleFinite: clean passes; each kind of poison is caught
  check(sampleFinite(goodSample()), "clean sample passes");
  { Sample s = goodSample(); s.x[3] = std::nanf(""); check(!sampleFinite(s), "NaN in x rejected"); }
  { Sample s = goodSample(); s.x[3] = 1e30f;          check(!sampleFinite(s), "absurd finite x rejected"); }
  { Sample s = goodSample(); s.pi[2] = 5.0f;          check(!sampleFinite(s), "out-of-range pi rejected"); }
  { Sample s = goodSample(); s.z = 1e9;               check(!sampleFinite(s), "out-of-range z rejected"); }
  { Sample s = goodSample(); s.z = INFINITY;          check(!sampleFinite(s), "infinite z rejected"); }

  // 2) ReplayBuffer.add drops the bad ones and reports the count
  {
    ReplayBuffer rb(1000);
    std::vector<Sample> batch = { goodSample(), goodSample() };
    batch[1].x[5] = std::nanf("");                    // poison the second
    int dropped = rb.add(batch);
    check(dropped == 1, "ReplayBuffer dropped exactly the 1 bad sample");
    check(rb.size() == 1, "only the clean sample entered the buffer");
  }

  // 3) net.finite() detects a poisoned weight; clampWeights bounds a runaway finite weight
  {
    Net net(INPUT_DIM, {256, 256, 256, 256}, NPOL, 0.05, 3);
    check(net.finite(), "fresh net is finite");
    net.W[1][7] = std::nanf("");
    check(!net.finite(), "net.finite() catches a NaN weight (refuse to push)");
    net.W[1][7] = 0.0f;                               // repair for the clamp test
    net.W[0][0] = 1e6f; net.Wp[0] = -1e6f;            // simulate runaway
    net.clampWeights(10.0);
    check(net.finite() && net.W[0][0] <= 10.0f && net.Wp[0] >= -10.0f, "clampWeights bounds runaway weights to [-10,10]");
  }

  std::printf("\nguards test: %d passed, %d failed\n", ok, fail);
  return fail ? 1 : 0;
}
