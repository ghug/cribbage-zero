// test_scoring.cpp — cribbage scoring unit tests (the perfect 29 + known hands + pegging).
#include "../scoring.h"
#include <cstdio>

using namespace cz;
static int ok = 0, fail = 0;
static void check(bool c, const char* m) { if (c) ok++; else { fail++; std::printf("  x %s\n", m); } }

int main() {
  // suits: spade=0, heart=1, diamond=2, club=3
  // 1) the perfect 29: three 5s + J, cut the fourth 5 in the jack's suit. 16 fifteens + 12 pairs + 1 nobs.
  {
    Card four[4] = {{5,0},{5,1},{5,2},{11,3}};   // 5s + J of clubs
    Card starter = {5,3};                          // 5 of clubs (matches the J's suit → nobs)
    Cats acc;
    int t = scoreInto(four, starter, false, &acc);
    check(t == 29, "perfect 29 total");
    check(acc.fifteen == 16, "perfect 29: 16 from fifteens");
    check(acc.pair == 12, "perfect 29: 12 from pairs");
    check(acc.nobs == 1, "perfect 29: 1 nobs");
    check(acc.run == 0 && acc.flush == 0, "perfect 29: no run/flush");
  }

  // 2) a plain run of three + a fifteen: 5 6 7 + (Q, 3 cut). 5+6+7? no =18. 5+? ... use 4,5,6 + 9,10:
  //    hand 4,5,6 and a 10; cut 9 → run 4-5-6 (3) and 6+9=15? 6+9=15 (2); 5+10=15(2); 4+5+6=15(2); 9+6=15.
  {
    Card four[4] = {{4,0},{5,1},{6,2},{10,3}};
    Card starter = {9,0};
    Cats acc;
    int t = scoreInto(four, starter, false, &acc);
    // fifteens: {6,9}=15, {5,10}=15, {4,5,6}=15  -> 3 fifteens = 6
    // runs: 4,5,6 (and 9 is not adjacent to 6? 6,7,8,9 — no 7,8) -> only 4-5-6 = 3
    check(acc.fifteen == 6, "run-hand: 3 fifteens (6 pts)");
    check(acc.run == 3, "run-hand: run of 3");
    check(t == 9, "run-hand total 9");
  }

  // 3) a 4-card hand flush (not crib) = 4; same hand as a crib (isCrib) without the starter suit = 0.
  //    hearts 2,6,8,J have no fifteen/pair/run; starter 4 of spades adds nothing (off-suit, no fifteen).
  {
    Card four[4] = {{2,1},{6,1},{8,1},{11,1}};   // all hearts
    Card starter = {4,0};                          // 4 of spades
    Cats a1; int hand = scoreInto(four, starter, false, &a1);
    Cats a2; int crib = scoreInto(four, starter, true, &a2);
    check(a1.flush == 4, "hand flush = 4");
    check(a2.flush == 0, "crib flush (starter off-suit) = 0");
    check(hand == 4, "flush hand total 4");
    check(crib == 0, "flush crib total 0");
  }

  // 4) pegging: 7 + 8 → count 15 (2). then a pair. then a run.
  {
    check(pegScore({7, 8}, 15) == 2, "peg fifteen = 2");
    check(pegScore({5, 5}, 10) == 2, "peg pair = 2");
    check(pegScore({5, 5, 5}, 15) == 6 + 2, "peg pair-royal(6) + fifteen(2)");   // 3 fives = pair-royal 6, count 15 = 2
    check(pegScore({3, 5, 4}, 12) == 3, "peg run of 3 (out of order)");
    check(pegScore({10, 5}, 15) == 2, "peg 10+5 fifteen");
    check(pegScore({6, 7, 8, 9}, 30) == 4, "peg run of 4");
  }

  std::printf("\nscoring test: %d passed, %d failed\n", ok, fail);
  return fail ? 1 : 0;
}
