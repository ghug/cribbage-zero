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

struct SearchResult {
  std::array<double, NPOL> policy{};  // visit distribution over the root's own legal slots
  int move = -1;
  double value = 0;
};

class Mcts {
public:
  // search from `root` for nSims; rng drives BOTH the per-sim determinization and the in-tree chance steps
  // (this is the SEARCH rng — kept separate from the real game's deal rng by the caller).
  SearchResult search(const CribGame& root, const Net& net, int nSims, double cPuct, Rng& rng) {
    arena_.clear();
    int rootPlayer = root.toAct;
    MNode* rnode = newNode();
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
    int best = -1; double bestSc = -1e300;
    for (int s = 0; s < NPOL; s++) {
      if (!legal[s]) continue;
      MNode* ch = node->child[s];
      int cN = ch ? ch->N : 0; double cW = ch ? ch->W : 0;
      double q = cN > 0 ? sign * (cW / cN) : 0;          // Q from the node-player's perspective
      double u = cPuct * node->P[s] * sqrtN / (1 + cN);
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
