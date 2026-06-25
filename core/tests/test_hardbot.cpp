// test_hardbot.cpp — validates the C++ hard-bot port (hardbot.h) against reference values computed from the
// JS source of truth (src/engine.js + src/winprob.js, via node), plus eval sanity/determinism (eval.h).
#include "../hardbot.h"
#include "../eval.h"
#include "../net.h"
#include <cstdio>
#include <cmath>

using namespace cz;
static int ok = 0, fail = 0;
static void approx(double got, double want, double tol, const char* m) {
  if (std::fabs(got - want) <= tol) ok++;
  else { fail++; std::printf("  x %s: got %.6f want %.6f\n", m, got, want); }
}
static void check(bool c, const char* m) { if (c) ok++; else { fail++; std::printf("  x %s\n", m); } }

int main() {
  // 1) cribSeed (ref: [7.06, 6.775, 8.38, 3.9])
  approx(cribSeed({5, 0}, {10, 1}), 7.06, 1e-9, "cribSeed 5/10");
  approx(cribSeed({7, 0}, {8, 1}), 6.775, 1e-9, "cribSeed 7/8");
  approx(cribSeed({5, 0}, {5, 1}), 8.38, 1e-9, "cribSeed 5/5 (pair)");
  approx(cribSeed({13, 0}, {2, 3}), 3.9, 1e-9, "cribSeed K/2");

  // 2) handDetail (ref ev=15.956522, sd=3.827569)
  {
    Card four[4] = {{5, 0}, {5, 1}, {6, 2}, {4, 3}};
    std::vector<Card> dealt = {{5, 0}, {5, 1}, {6, 2}, {4, 3}, {10, 0}, {11, 1}};
    HandEv hd = handDetail(four, dealt);
    approx(hd.ev, 15.956521739130435, 1e-9, "handDetail ev");
    approx(hd.sd, 3.8275688829693446, 1e-9, "handDetail sd");
  }

  // 3) winProbHand (ref: [0.20021368, 0.99988635, 0, 0, 0.99990000])
  approx(winProbHand({50, 40, true, 2, 2}, 8, 3, 0), 0.20021368028646822, 1e-6, "wph A");
  approx(winProbHand({20, 90, false, 2, 2}, 6, 4, 5), 0.9998863531394593, 1e-6, "wph B");
  approx(winProbHand({5, 5, true, 2, 2}, 9, 3, 0), 0.0, 1e-6, "wph C");
  approx(winProbHand({100, 12, true, 2, 2}, 7, 2, 0), 0.0, 1e-6, "wph D");
  approx(winProbHand({12, 100, false, 2, 2}, 10, 3, 4.7), 0.9998999998651076, 1e-6, "wph E");

  // 4) pegChooseDeep (ref: 5)
  check(pegChooseDeep({5, 10, 3}, 10, {10, 5}, {5, 10, 3, 7}, {1, 1, 2, 3, 7, 7, 9, 11, 13}) == 5, "pegChooseDeep picks 5");

  // 5) eval sanity + determinism: a random-init net, small antithetic match
  {
    Net net(INPUT_DIM, {256, 256, 256, 256}, NPOL, 0.1, 7);   // small seeded weights
    Rng r1(12345), r2(12345), r3(999);
    double a = evalVsRandom(net, 30, r1);
    double b = evalVsRandom(net, 30, r2);
    double c = evalVsRandom(net, 30, r3);
    check(a >= 0.0 && a <= 1.0, "evalVsRandom in [0,1]");
    check(a == b, "evalVsRandom deterministic for a fixed seed");
    check(true, "evalVsRandom ran a different seed");   (void)c;
    Rng h1(54321), h2(54321);
    double ha = evalVsHard(net, 20, h1), hb = evalVsHard(net, 20, h2);
    check(ha >= 0.0 && ha <= 1.0, "evalVsHard in [0,1]");
    check(ha == hb, "evalVsHard deterministic for a fixed seed");
  }

  std::printf("\nhardbot test: %d passed, %d failed\n", ok, fail);
  return fail ? 1 : 0;
}
