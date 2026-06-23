// game.h — heads-up cribbage as a step-based RL/search environment, ported from engine/az_game.js.
// Decisions: discard (slot 0..14 = the 15 two-card combos of the 6-card hand) and pegging (slot = index into
// the current peg hand, legal if it keeps the count <= 31). Chance (deal/cut) and the show resolve between
// decisions. Race to 121. encode(player) is the fixed 247-dim feature vector from the player's information set.
#pragma once
#include "cards.h"
#include "scoring.h"
#include "rng.h"
#include <vector>
#include <array>
#include <cstdint>

namespace cz {

inline constexpr int TARGET = 121;
inline constexpr int NPOL = 15;
inline constexpr int INPUT_DIM = 6 * 17 + 2 + 2 + 1 + 7 * 17 + 2 + 1 + 1 + 17; // 247

// the 15 two-card combos of a 6-card hand (i<j)
inline const std::array<std::pair<int, int>, 15>& combos6() {
  static const std::array<std::pair<int, int>, 15> C = [] {
    std::array<std::pair<int, int>, 15> a{};
    int n = 0;
    for (int i = 0; i < 6; i++) for (int j = i + 1; j < 6; j++) a[n++] = {i, j};
    return a;
  }();
  return C;
}

class CribGame {
public:
  std::array<int, 2> scores{0, 0};
  int dealer = 0, pone = 1, toAct = 0;
  bool done = false;
  int winner = -1;
  int phase = 0; // 0 = discard, 1 = peg

  std::array<std::vector<Card>, 2> six;   // 6-card dealt hands
  std::array<std::vector<Card>, 2> kept;  // 4-card kept hands
  std::vector<Card> crib;
  Card starter{0, 0};
  bool hasStarter = false;
  Card cutCard{0, 0};   // the post-deal cut, revealed as `starter` after discards (pre-dealt from the shuffle)

  // pegging sub-state
  int count = 0;
  std::vector<int> pile;          // ranks since last reset
  std::vector<Card> playedSuited; // every card played this hand, in order (suited)
  std::array<std::vector<Card>, 2> pegHand;
  std::array<int, 2> goLow{0, 0};
  int pegPasses = 0, pegLast = -1;

  // initial dealer is set by the caller (not random) so self-play can run mirrored/antithetic pairs.
  CribGame(Rng& dealRng, int initialDealer) {
    dealer = initialDealer;
    deal(dealRng);
  }
  CribGame() = default; // for clone()

  // one Fisher-Yates shuffle of the 52-deck, then slice 6+6 and pre-deal the cut card (O(52), no per-draw
  // reallocation). The cut stays hidden until afterDiscards, so encode/determinize never leak it early.
  void deal(Rng& rng) {
    std::vector<Card> d = fullDeck();
    for (int i = 51; i > 0; i--) { int j = rng.below(i + 1); std::swap(d[i], d[j]); }
    pone = 1 - dealer;
    six[dealer].assign(d.begin(), d.begin() + 6);
    six[pone].assign(d.begin() + 6, d.begin() + 12);
    cutCard = d[12];
    kept[0].clear(); kept[1].clear();
    crib.clear(); hasStarter = false;
    count = 0; pile.clear(); playedSuited.clear();
    pegHand[0].clear(); pegHand[1].clear();
    goLow = {0, 0}; pegPasses = 0; pegLast = -1;
    phase = 0; toAct = pone;
  }

  // legal action slots for the current decision
  std::vector<bool> legalSlots() const {
    std::vector<bool> legal(NPOL, false);
    if (done) return legal;
    if (phase == 0) { for (int j = 0; j < 15; j++) legal[j] = true; }
    else {
      const auto& hand = pegHand[toAct];
      for (int s = 0; s < (int)hand.size(); s++) if (pval(hand[s].r) + count <= 31) legal[s] = true;
    }
    return legal;
  }

  // apply a slot, then advance chance/deterministic steps to the next decision (or terminal)
  void step(int slot, Rng& rng) {
    if (phase == 0) {
      auto [i, j] = combos6()[slot];
      const auto& s6 = six[toAct];
      std::vector<Card> k;
      for (int t = 0; t < 6; t++) if (t != i && t != j) k.push_back(s6[t]);
      kept[toAct] = k;
      crib.push_back(s6[i]); crib.push_back(s6[j]);
      if (toAct == pone) toAct = dealer;
      else afterDiscards(rng);
      return;
    }
    int me = toAct;
    auto& hand = pegHand[me];
    Card card = hand[slot];
    hand.erase(hand.begin() + slot);
    pile.push_back(card.r); playedSuited.push_back(card); count += pval(card.r);
    if (award(me, pegScore(pile, count))) return;
    pegLast = me; pegPasses = 0;
    if (count == 31) { count = 0; pile.clear(); pegLast = -1; }
    advancePeg(rng, false);
  }

private:
  void afterDiscards(Rng& rng) {
    starter = cutCard; hasStarter = true;   // the cut was pre-dealt from this hand's shuffle (deck[12])
    if (starter.r == 11) { if (award(dealer, 2)) return; } // his heels
    phase = 1;
    pegHand[0] = kept[0]; pegHand[1] = kept[1];
    count = 0; pile.clear(); playedSuited.clear(); pegPasses = 0; pegLast = -1; goLow = {0, 0};
    toAct = pone;
    advancePeg(rng, true);
  }

  void advancePeg(Rng& rng, bool justStarted) {
    if (!justStarted) toAct = 1 - toAct;
    int guard = 0;
    while (guard++ < 20) {
      int remaining = (int)pegHand[0].size() + (int)pegHand[1].size();
      if (remaining == 0) { if (pegLast >= 0) { if (award(pegLast, 1)) return; } return show(rng); }
      const auto& hand = pegHand[toAct];
      bool canPlay = false;
      for (const auto& c : hand) if (pval(c.r) + count <= 31) { canPlay = true; break; }
      if (canPlay) return; // a real decision awaits
      // current player must "go" — record the lowest count they were blocked at this hand
      if (count > 0 && (goLow[toAct] == 0 || count < goLow[toAct])) goLow[toAct] = count;
      if (++pegPasses >= 2) {
        if (pegLast >= 0 && count != 31) { if (award(pegLast, 1)) return; }
        count = 0; pile.clear(); pegPasses = 0; pegLast = -1;
      }
      toAct = 1 - toAct;
    }
  }

  void show(Rng& rng) {
    Cats acc;
    Card f[4];
    auto four = [&](const std::vector<Card>& h) { for (int i = 0; i < 4; i++) f[i] = h[i]; };
    four(kept[pone]); if (award(pone, scoreInto(f, starter, false, &acc))) return;
    four(kept[dealer]); if (award(dealer, scoreInto(f, starter, false, &acc))) return;
    four(crib); if (award(dealer, scoreInto(f, starter, true, &acc))) return;
    dealer = 1 - dealer;
    deal(rng);
  }

  bool award(int seat, int pts) {
    scores[seat] += pts;
    if (scores[seat] >= TARGET) { done = true; winner = seat; return true; }
    return false;
  }

public:
  // ----- net interface: fixed-length features from `player`'s information set (opponent cards hidden) -----
  std::vector<double> encode(int player) const {
    std::vector<double> fv;
    fv.reserve(INPUT_DIM);
    int opp = 1 - player;
    auto pushCard = [&](const Card* c) {
      int r = c ? c->r - 1 : -1, su = c ? c->s : -1;
      for (int k = 0; k < 13; k++) fv.push_back(k == r ? 1.0 : 0.0);
      for (int k = 0; k < 4; k++) fv.push_back(k == su ? 1.0 : 0.0);
    };
    // own 6 slots: discard → the six dealt cards; peg → [ph0..ph3, disc0, disc1]
    const Card* slots[6] = {nullptr, nullptr, nullptr, nullptr, nullptr, nullptr};
    std::vector<Card> disc;
    if (phase == 0) {
      for (int i = 0; i < (int)six[player].size() && i < 6; i++) slots[i] = &six[player][i];
    } else {
      const auto& ph = pegHand[player];
      for (int i = 0; i < (int)ph.size() && i < 4; i++) slots[i] = &ph[i];
      // disc = six[player] minus kept[player]
      for (const auto& c : six[player]) {
        bool inKept = false;
        for (const auto& kc : kept[player]) if (kc == c) { inKept = true; break; }
        if (!inKept) disc.push_back(c);
      }
      if (disc.size() > 0) slots[4] = &disc[0];
      if (disc.size() > 1) slots[5] = &disc[1];
    }
    for (int p = 0; p < 6; p++) pushCard(slots[p]);
    // phase + who deals
    fv.push_back(phase == 1 ? 1.0 : 0.0);
    fv.push_back(dealer == player ? 1.0 : 0.0);
    // scores to-go (normalized), mine then opp
    fv.push_back((TARGET - scores[player]) / (double)TARGET);
    fv.push_back((TARGET - scores[opp]) / (double)TARGET);
    // pip count to 31
    fv.push_back((count) / 31.0);
    // last-7 played window (oldest..newest)
    int np = (int)playedSuited.size();
    int take = phase == 1 ? std::min(np, 7) : 0;
    int off = 7 - take;
    for (int p = 0; p < 7; p++) {
      if (p >= off) pushCard(&playedSuited[np - take + (p - off)]);
      else pushCard(nullptr);
    }
    // peg-hand sizes
    fv.push_back(phase == 1 ? pegHand[player].size() / 4.0 : 0.0);
    fv.push_back(phase == 1 ? pegHand[opp].size() / 4.0 : 0.0);
    // opponent go-headroom
    int gl = goLow[opp];
    fv.push_back(gl > 0 ? std::min(31 - gl, 10) / 10.0 : 0.0);
    // current sub-pile length
    fv.push_back((phase == 1 ? std::min((int)pile.size(), 7) : 0) / 7.0);
    // starter
    Card st = starter;
    pushCard(hasStarter ? &st : nullptr);
    return fv;
  }

  // clone with the opponent's hidden cards resampled from the unseen pool (IS-MCTS determinization)
  CribGame determinize(int player, Rng& rng) const {
    CribGame g = *this;
    int opp = 1 - player;
    uint8_t seen[52] = {0};
    const auto& mine = (g.phase == 0) ? g.six[player] : g.kept[player];
    for (const auto& c : mine) seen[cardId(c)] = 1;
    if (g.hasStarter) seen[cardId(g.starter)] = 1;
    for (const auto& c : g.playedSuited) seen[cardId(c)] = 1;
    std::vector<Card> pool;
    for (int r = 1; r <= 13; r++) for (int s = 0; s < 4; s++) { Card c{r, s}; if (!seen[cardId(c)]) pool.push_back(c); }
    for (int i = (int)pool.size() - 1; i > 0; i--) { int j = rng.below(i + 1); std::swap(pool[i], pool[j]); }
    if (g.phase == 0) { g.six[opp].assign(pool.begin(), pool.begin() + 6); }
    else { int need = (int)g.pegHand[opp].size(); g.pegHand[opp].assign(pool.begin(), pool.begin() + need); }
    return g;
  }
};

} // namespace cz
