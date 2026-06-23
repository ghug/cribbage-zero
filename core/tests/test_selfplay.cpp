// test_selfplay.cpp — game-env sanity, antithetic-pairing check, and an MCTS self-play smoke.
#include "../selfplay.h"
#include <cstdio>

using namespace cz;
static int ok = 0, fail = 0;
static void check(bool c, const char* m) { if (c) ok++; else { fail++; std::printf("  x %s\n", m); } }

int main() {
  // 1) random self-play sanity: games terminate, scores monotonic, exactly one side hits 121, encode is 247.
  {
    Rng rng(12345);
    int games = 0, stalled = 0, badScore = 0, badEnc = 0, illegal = 0;
    for (int gi = 0; gi < 2000; gi++) {
      CribGame g(rng, gi % 2);
      std::array<int, 2> prev{0, 0};
      int guard = 0;
      while (!g.done && guard++ < 20000) {
        int player = g.toAct;
        auto legal = g.legalSlots();
        int ls[NPOL], n = 0;
        for (int s = 0; s < NPOL; s++) if (legal[s]) ls[n++] = s;
        if (n == 0) { illegal++; break; }
        if ((int)g.encode(player).size() != INPUT_DIM) badEnc++;
        if (g.scores[0] < prev[0] || g.scores[1] < prev[1]) badScore++;
        prev = g.scores;
        g.step(ls[rng.below(n)], rng);
      }
      if (!g.done) stalled++;
      else { if (g.scores[g.winner] < TARGET) badScore++; if (g.scores[1 - g.winner] >= TARGET) badScore++; }
      games++;
    }
    check(stalled == 0, "all games terminate");
    check(badScore == 0, "scores monotonic & exactly one side reaches 121");
    check(badEnc == 0, "encode() is always INPUT_DIM=247");
    check(illegal == 0, "every decision offers >=1 legal slot");
    std::printf("  random self-play: %d games, %d stalled, %d score-bad\n", games, stalled, badScore);
  }

  // 2) antithetic pairing: the two games in a pair share the same shuffle, mirrored — the dealer's 6 cards and
  //    the cut match across the pair, with the seats swapped.
  {
    uint32_t seed = 777;
    Rng da(seed); CribGame ga(da, 0);   // dealer = seat 0
    Rng db(seed); CribGame gb(db, 1);   // dealer = seat 1
    bool mirrored = ga.six[0].size() == 6 && gb.six[1].size() == 6;
    for (int i = 0; i < 6 && mirrored; i++) mirrored = ga.six[0][i] == gb.six[1][i]; // dealer's hand = same cards
    bool sameCut = ga.cutCard == gb.cutCard;
    check(mirrored, "antithetic: dealer's 6 cards match across the mirrored pair");
    check(sameCut, "antithetic: cut card matches across the pair");
  }

  // 3) MCTS self-play smoke: well-formed samples, then check the net can fit its own self-play targets.
  {
    Net net(INPUT_DIM, {32}, NPOL, 0.0, /*seed=*/7);
    Mcts mcts;
    Rng searchRng(2024);
    std::vector<Sample> data;
    int pairs = 8, sims = 15;
    for (int p = 0; p < pairs; p++) playMatchPair(net, sims, 1.5, 1000u + p, searchRng, mcts, data);

    check(!data.empty(), "self-play produced samples");
    int badX = 0, badPi = 0, badZ = 0, winN = 0, lossN = 0;
    for (auto& s : data) {
      if ((int)s.x.size() != INPUT_DIM) badX++;
      double sum = 0; bool onlyLegal = true;
      for (int j = 0; j < NPOL; j++) { sum += s.pi[j]; if (s.pi[j] > 0 && !s.legal[j]) onlyLegal = false; }
      if (std::fabs(sum - 1.0) > 1e-4 || !onlyLegal) badPi++;
      if (s.z != 1.0 && s.z != -1.0) badZ++;
      if (s.z == 1.0) winN++; else lossN++;
    }
    check(badX == 0, "every sample x is INPUT_DIM");
    check(badPi == 0, "every pi sums to 1 over legal slots only");
    check(badZ == 0, "every z is +-1");
    check(winN > 0 && lossN > 0, "both wins and losses appear in the targets");

    // a quick SGD pass: the net should fit its own targets (training loss drops)
    auto avgLoss = [&](Net& n) {
      double L = 0; for (auto& s : data) { Forward f = n.forward(s.x); auto p = Net::softmax(f.logits, s.legal);
        double lp = 0; for (int j = 0; j < NPOL; j++) if (s.legal[j] && s.pi[j] > 0) lp -= s.pi[j] * std::log(std::max(1e-12, (double)p[j]));
        L += 0.5 * (f.v - s.z) * (f.v - s.z) + lp; }
      return L / data.size();
    };
    double before = avgLoss(net);
    Rng tr(99);
    for (int it = 0; it < 4000; it++) { auto& s = data[tr.below((int)data.size())]; net.trainStep(s.x, s.z, s.pi, s.legal, 0.02); }
    double after = avgLoss(net);
    check(after < before, "net fits its own self-play targets (training loss drops)");
    std::printf("  self-play: %zu samples (%d win / %d loss), loss %.3f -> %.3f\n", data.size(), winN, lossN, before, after);
  }

  std::printf("\nselfplay test: %d passed, %d failed\n", ok, fail);
  return fail ? 1 : 0;
}
