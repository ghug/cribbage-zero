// mcts.h — single-observer Information-Set MCTS with PUCT, ported from engine/az_mcts.js.
// Each simulation re-determinizes the opponent's hidden cards, descends a SHARED tree (so stats aggregate
// across determinizations — avoids PIMC strategy fusion), evaluates leaves with the net, and backs up values
// in the ROOT player's perspective. score(s) = Q(s) + cPuct·P(s)·sqrt(ΣN)/(1+N(s)).
#pragma once
#include "game.h"
#include "net.h"
#include <deque>
#include <array>
#include <cmath>

namespace cz {

struct MNode {
  int N = 0;
  double W = 0;
  bool expanded = false;
  std::array<double, NPOL> P{};       // policy prior (set on expansion)
  std::array<MNode*, NPOL> child{};   // children, null until visited
};

// Gamma / Dirichlet sampling for AlphaZero root-exploration noise (Marsaglia-Tsang; α<1 via the boost trick).
inline double sampleNormal(Rng& rng) {
  double u1 = rng.next(), u2 = rng.next();
  return std::sqrt(-2.0 * std::log(u1 + 1e-12)) * std::cos(6.283185307179586 * u2);
}
inline double sampleGamma(double a, Rng& rng) {
  if (a < 1.0) return sampleGamma(a + 1.0, rng) * std::pow(rng.next() + 1e-12, 1.0 / a);
  double d = a - 1.0 / 3.0, c = 1.0 / std::sqrt(9.0 * d);
  for (;;) {
    double x = sampleNormal(rng), v = 1.0 + c * x;
    if (v <= 0) continue;
    v = v * v * v;
    double u = rng.next();
    if (u < 1.0 - 0.0331 * x * x * x * x) return d * v;
    if (std::log(u + 1e-12) < 0.5 * x * x + d * (1.0 - v + std::log(v))) return d * v;
  }
}

struct SearchResult {
  std::array<double, NPOL> policy{};  // visit distribution over the root's own legal slots
  int move = -1;
  double value = 0;
};

class Mcts {
public:
  // search from `root` for nSims; rng drives the per-sim determinization, in-tree chance, AND the root
  // exploration noise (the SEARCH rng — kept separate from the real game's deal rng by the caller).
  // dirEps>0 mixes Dirichlet(dirAlpha) noise into the root prior (AlphaZero self-play exploration); 0 = off.
  SearchResult search(const CribGame& root, const Net& net, int nSims, double cPuct, Rng& rng,
                      double dirEps = 0.0, double dirAlpha = 0.8, double fpu = 0.0, double cBase = 0.0) {
    arena_.clear();
    fpu_ = fpu; cBase_ = cBase;
    int rootPlayer = root.toAct;
    MNode* rnode = newNode();
    // pre-expand the root (its prior/legals depend only on the root player's own info → determinization-
    // independent) so we can perturb the prior with Dirichlet noise before the simulations run.
    {
      auto legal = root.legalSlots();
      root.encodeInto(rootPlayer, enc_);
      float v; net.infer(enc_, sa_, sb_, logits_, v);
      auto p = Net::softmax(logits_, legal);
      for (int s = 0; s < NPOL; s++) rnode->P[s] = p[s];
      rnode->expanded = true;
      if (dirEps > 0) {
        double g[NPOL] = {0}, sum = 0;
        for (int s = 0; s < NPOL; s++) if (legal[s]) { g[s] = sampleGamma(dirAlpha, rng); sum += g[s]; }
        if (sum > 0) for (int s = 0; s < NPOL; s++) if (legal[s]) rnode->P[s] = (1 - dirEps) * rnode->P[s] + dirEps * (g[s] / sum);
      }
    }
    for (int i = 0; i < nSims; i++) {
      CribGame g = root.determinize(rootPlayer, rng);
      simulate(g, rnode, rootPlayer, net, cPuct, rng);
    }
    SearchResult res;
    long tot = 0;
    for (int s = 0; s < NPOL; s++) { MNode* ch = rnode->child[s]; if (ch) { res.policy[s] = ch->N; tot += ch->N; } }
    if (tot > 0) for (int s = 0; s < NPOL; s++) res.policy[s] /= (double)tot;
    int move = -1; double best = -1;
    for (int s = 0; s < NPOL; s++) if (res.policy[s] > best) { best = res.policy[s]; move = s; }
    res.move = move;
    res.value = rnode->N ? rnode->W / rnode->N : 0;
    return res;
  }

private:
  std::deque<MNode> arena_;            // stable addresses across push_back; one tree per search
  MNode* newNode() { arena_.emplace_back(); return &arena_.back(); }
  // reused scratch (one Mcts per thread) → the hot path allocates nothing per sim
  std::vector<float> enc_, sa_, sb_, logits_;
  double fpu_ = 0.0, cBase_ = 0.0;     // FPU reduction; c_puct log-scaling base (0 = off, set per search)

  double simulate(CribGame& g, MNode* node, int rootPlayer, const Net& net, double cPuct, Rng& rng) {
    node->N++;
    if (g.done) { double v = (g.winner == rootPlayer) ? 1.0 : -1.0; node->W += v; return v; }
    if (!node->expanded) {                               // expand + net-evaluate (one new node per sim)
      int player = g.toAct;
      auto legal = g.legalSlots();
      g.encodeInto(player, enc_);
      float fv; net.infer(enc_, sa_, sb_, logits_, fv);  // inference-only forward, scratch buffers
      auto p = Net::softmax(logits_, legal);
      for (int s = 0; s < NPOL; s++) node->P[s] = p[s];
      node->expanded = true;
      double v = (player == rootPlayer) ? fv : -fv;      // → root perspective
      node->W += v;
      return v;
    }
    int player = g.toAct;
    auto legal = g.legalSlots();
    double sign = (player == rootPlayer) ? 1.0 : -1.0;
    double sqrtN = std::sqrt((double)std::max(1, node->N));
    double cp = cPuct + (cBase_ > 0 ? std::log((node->N + cBase_ + 1.0) / cBase_) : 0.0);  // c_puct log-scaling
    double parentVal = node->N > 0 ? sign * (node->W / node->N) : 0.0;                      // for FPU
    int best = -1; double bestSc = -1e300;
    for (int s = 0; s < NPOL; s++) {
      if (!legal[s]) continue;
      MNode* ch = node->child[s];
      int cN = ch ? ch->N : 0; double cW = ch ? ch->W : 0;
      // Q from the node-player's perspective; unvisited children use FPU (parent value − reduction) not 0.
      double q = cN > 0 ? sign * (cW / cN) : (parentVal - fpu_);
      double u = cp * node->P[s] * sqrtN / (1 + cN);
      double sc = q + u;
      if (sc > bestSc) { bestSc = sc; best = s; }
    }
    MNode*& ch = node->child[best];
    if (!ch) ch = newNode();
    g.step(best, rng);
    double v = simulate(g, ch, rootPlayer, net, cPuct, rng);
    node->W += v;
    return v;
  }
};

} // namespace cz
