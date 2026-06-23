// cards.h — card representation for cribbage. Rank r: 1..13 (A=1 … K=13); suit s: 0..3.
#pragma once
#include <array>
#include <vector>

namespace cz {

struct Card {
  int r; // 1..13
  int s; // 0..3
};

inline bool operator==(const Card& a, const Card& b) { return a.r == b.r && a.s == b.s; }

inline int pval(int r) { return r < 10 ? r : 10; }            // pip value (face cards = 10)
inline int cardId(const Card& c) { return (c.r - 1) * 4 + c.s; } // 0..51

// full 52-card deck
inline std::vector<Card> fullDeck() {
  std::vector<Card> d;
  d.reserve(52);
  for (int r = 1; r <= 13; r++)
    for (int s = 0; s < 4; s++) d.push_back({r, s});
  return d;
}

} // namespace cz
