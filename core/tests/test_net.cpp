// test_net.cpp — numeric gradient check + a toy-learning test. Uses NetT<double> so the finite-difference
// check stays rigorous (production is NetT<float>; same code path). Weights are FLAT per layer (W[l][i*din+k]).
#include "../net.h"
#include <cstdio>

using namespace cz;
using Netd = NetT<double>;
static int ok = 0, fail = 0;
static void check(bool c, const char* m) { if (c) ok++; else { fail++; std::printf("  x %s\n", m); } }

static double loss(Netd& net, const std::vector<double>& x, double z, const std::vector<double>& pi,
                   const std::vector<bool>& legal, double cPol = 1.0) {
  ForwardT<double> f = net.forward(x);
  std::vector<double> p = Netd::softmax(f.logits, legal);
  double lp = 0;
  for (size_t j = 0; j < pi.size(); j++) if (legal[j] && pi[j] > 0) lp -= pi[j] * std::log(std::max(1e-12, p[j]));
  return 0.5 * (f.v - z) * (f.v - z) + cPol * lp;
}

int main() {
  // 1) gradient check on a 2-hidden-layer net (din: 5->6->4). Weights flat: W[l][i*din + k].
  {
    Netd net(5, {6, 4}, 3, /*seedW=*/0.5);
    std::vector<double> x = {0.4, -0.7, 0.1, 0.9, -0.3};
    double z = 0.3;
    std::vector<bool> legal = {true, true, false};
    std::vector<double> pi = {0.6, 0.4, 0.0};
    struct P { double* p; const char* name; };
    std::vector<P> params = {
      {&net.W[0][2 * 5 + 3], "W[0][2][3]"}, {&net.b[0][1], "b[0][1]"},
      {&net.W[1][3 * 6 + 2], "W[1][3][2]"}, {&net.b[1][2], "b[1][2]"},
      {&net.Wv[3], "Wv[3]"}, {&net.Wp[0 * net.nHid + 1], "Wp[0][1]"}, {&net.bp[2], "bp[2]"},
    };
    const double e = 1e-5;
    std::vector<double> numG, before;
    for (auto& pr : params) {
      double v0 = *pr.p;
      *pr.p = v0 + e; double lp = loss(net, x, z, pi, legal);
      *pr.p = v0 - e; double lm = loss(net, x, z, pi, legal);
      *pr.p = v0;
      numG.push_back((lp - lm) / (2 * e)); before.push_back(v0);
    }
    net.trainStep(x, z, pi, legal, 1.0);
    for (size_t i = 0; i < params.size(); i++) {
      double analytic = (before[i] - *params[i].p) / 1.0;
      bool good = std::fabs(analytic - numG[i]) < 1e-5;
      check(good, params[i].name);
      if (!good) std::printf("    %s: analytic %.6f vs numeric %.6f\n", params[i].name, analytic, numG[i]);
    }
  }

  // 2) toy learning from random init
  {
    Netd net(4, {16, 16}, 3, 0.0, 12345);
    std::vector<bool> legal = {true, true, true};
    Rng rng(999);
    auto sample = [&](std::vector<double>& x, double& z, std::vector<double>& pi, int& best) {
      x = {rng.next(), rng.next(), rng.next(), rng.next()};
      z = std::tanh(2 * (x[0] - x[1]));
      best = x[0] > x[2] ? (x[1] > 0.5 ? 0 : 1) : 2;
      pi = {0, 0, 0}; pi[best] = 1;
    };
    std::vector<double> x, pi; double z; int best;
    double pre = 0; for (int i = 0; i < 400; i++) { sample(x, z, pi, best); pre += loss(net, x, z, pi, legal); } pre /= 400;
    for (int it = 0; it < 60000; it++) { sample(x, z, pi, best); net.trainStep(x, z, pi, legal, 0.03); }
    double post = 0; int correct = 0;
    for (int i = 0; i < 1000; i++) {
      sample(x, z, pi, best);
      post += loss(net, x, z, pi, legal);
      ForwardT<double> f = net.forward(x);
      auto p = Netd::softmax(f.logits, legal);
      int arg = 0; for (int j = 1; j < 3; j++) if (p[j] > p[arg]) arg = j;
      if (arg == best) correct++;
    }
    post /= 1000;
    check(post < pre * 0.5, "toy loss drops with training");
    check(correct / 1000.0 > 0.9, "toy policy accuracy > 90%");
    std::printf("  toy: loss %.3f -> %.3f, policy acc %.1f%%\n", pre, post, correct / 10.0);
  }

  std::printf("\nnet test: %d passed, %d failed\n", ok, fail);
  return fail ? 1 : 0;
}
