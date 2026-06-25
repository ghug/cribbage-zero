// buffer.h — bounded replay buffer (sliding window) + decorrelated mini-batch SGD, ported from
// engine/az_contribute.js trainReplay. Random draws with replacement decorrelate within-game positions.
#pragma once
#include "sample.h"
#include "net.h"
#include "rng.h"
#include <deque>

namespace cz {

class ReplayBuffer {
public:
  explicit ReplayBuffer(size_t cap) : cap_(cap) {}
  // add items, DROPPING any non-finite/out-of-range sample (bad bus data must never reach training). Returns
  // the number dropped so the caller can log it — that log is also the diagnostic if a bad source ever appears.
  int add(std::vector<Sample>& items) {
    int dropped = 0;
    for (auto& s : items) { if (sampleFinite(s)) buf_.push_back(std::move(s)); else dropped++; }
    while (buf_.size() > cap_) buf_.pop_front();   // evict oldest beyond the cap
    return dropped;
  }
  size_t size() const { return buf_.size(); }
private:
  std::deque<Sample> buf_;
  size_t cap_;
  friend double trainReplay(Net&, ReplayBuffer&, int, int, double, Rng&, double, bool, double);
};

// `steps` mini-batches of `batch` samples drawn at random WITH replacement. wd = L2 weight decay (applied
// decoupled, once per mini-batch); augment = on-the-fly suit-symmetry augmentation of each sample's input.
inline double trainReplay(Net& net, ReplayBuffer& rb, int steps, int batch, double lr, Rng& rng,
                          double wd = 0.0, bool augment = false, double wclamp = 0.0) {
  if (rb.buf_.empty()) return 0;
  double loss = 0; long n = 0;
  std::vector<float> xa;
  for (int s = 0; s < steps; s++) {
    for (int b = 0; b < batch; b++) {
      const Sample& d = rb.buf_[rng.below((int)rb.buf_.size())];
      if (augment) { xa = d.x; int sigma[4]; randomSuitPerm(sigma, rng); augmentSuits(xa, sigma); loss += net.trainStep(xa, d.z, d.pi, d.legal, lr); }
      else loss += net.trainStep(d.x, d.z, d.pi, d.legal, lr);
      n++;
    }
    if (wd > 0) net.scaleWeights(1.0 - lr * wd);   // decoupled L2, once per mini-batch
    if (wclamp > 0) net.clampWeights(wclamp);      // bound the unbounded-ReLU runaway (anti-NaN), once per mini-batch
  }
  return n ? loss / n : 0;
}

} // namespace cz
