// net.h — value+policy MLP for the AlphaZero loop, ported from engine/az_net.js.
// A stack of ReLU hidden layers feeding two heads: a scalar VALUE (tanh) and POLICY logits over the fixed
// action slots (softmax over the legal slots at use time). Trained by SGD on AlphaZero targets:
//   loss = 1/2 (v - z)^2  +  cPol * cross-entropy(softmax(logits)_legal, pi).
// Uses double (matches the JS reference exactly; keeps the finite-difference gradient check rigorous).
#pragma once
#include "rng.h"
#include <vector>
#include <cmath>
#include <algorithm>

namespace cz {

struct Forward {
  std::vector<std::vector<double>> acts; // acts[l] = input to layer l (acts[0] = x); acts.back() = last hidden
  double v = 0;
  std::vector<double> logits;
};

class Net {
public:
  int nIn, nPol, nHid;
  std::vector<int> hidden;
  std::vector<std::vector<std::vector<double>>> W; // W[l][i][k], shape sizes[l+1] x sizes[l]
  std::vector<std::vector<double>> b;              // b[l][i]
  std::vector<double> Wv; double bv = 0;           // value head
  std::vector<std::vector<double>> Wp;             // Wp[j][i]
  std::vector<double> bp;

  // seedW>0 → init every weight to U(-seedW, seedW) (used by the gradient check); else He-uniform via rng.
  Net(int nIn_, std::vector<int> hidden_, int nPol_, double seedW = 0.0, uint32_t seed = 1)
      : nIn(nIn_), nPol(nPol_), hidden(std::move(hidden_)) {
    nHid = hidden.back();
    Rng rng(seed);
    std::vector<int> sizes;
    sizes.push_back(nIn);
    for (int h : hidden) sizes.push_back(h);
    auto randu = [&](double r) { return (rng.next() * 2.0 - 1.0) * r; };
    for (size_t l = 0; l < hidden.size(); l++) {
      int din = sizes[l], dout = sizes[l + 1];
      double r = seedW > 0 ? seedW : std::sqrt(6.0 / din);
      W.emplace_back(dout, std::vector<double>(din));
      for (int i = 0; i < dout; i++) for (int k = 0; k < din; k++) W[l][i][k] = randu(r);
      b.emplace_back(dout, 0.0);
    }
    double rh = seedW > 0 ? seedW : std::sqrt(6.0 / nHid);
    Wv.resize(nHid);
    for (int i = 0; i < nHid; i++) Wv[i] = randu(rh);
    Wp.assign(nPol, std::vector<double>(nHid));
    for (int j = 0; j < nPol; j++) for (int i = 0; i < nHid; i++) Wp[j][i] = randu(rh);
    bp.assign(nPol, 0.0);
  }

  Forward forward(const std::vector<double>& x) const {
    Forward f;
    f.acts.push_back(x);
    std::vector<double> a = x;
    for (size_t l = 0; l < W.size(); l++) {
      const auto& Wl = W[l]; const auto& bl = b[l];
      int dout = (int)bl.size(), din = (int)a.size();
      std::vector<double> o(dout);
      const double* ap = a.data();
      // 4-way row blocking: load each a[k] once and fan it across 4 output neurons (the inner-loop a[k]
      // reload was the bottleneck). Bit-identical to the scalar form.
      int i = 0;
      for (; i + 4 <= dout; i += 4) {
        const double* W0 = Wl[i].data(); const double* W1 = Wl[i + 1].data();
        const double* W2 = Wl[i + 2].data(); const double* W3 = Wl[i + 3].data();
        double s0 = bl[i], s1 = bl[i + 1], s2 = bl[i + 2], s3 = bl[i + 3];
        for (int k = 0; k < din; k++) { double ak = ap[k]; s0 += W0[k] * ak; s1 += W1[k] * ak; s2 += W2[k] * ak; s3 += W3[k] * ak; }
        o[i] = s0 > 0 ? s0 : 0; o[i + 1] = s1 > 0 ? s1 : 0; o[i + 2] = s2 > 0 ? s2 : 0; o[i + 3] = s3 > 0 ? s3 : 0;
      }
      for (; i < dout; i++) { double s = bl[i]; const double* Wi = Wl[i].data(); for (int k = 0; k < din; k++) s += Wi[k] * ap[k]; o[i] = s > 0 ? s : 0; }
      a = std::move(o);
      f.acts.push_back(a);
    }
    const std::vector<double>& hLast = f.acts.back();
    double zv = bv;
    for (int i = 0; i < nHid; i++) zv += Wv[i] * hLast[i];
    f.v = std::tanh(zv);
    f.logits.assign(nPol, 0.0);
    for (int j = 0; j < nPol; j++) {
      double s = bp[j];
      for (int i = 0; i < nHid; i++) s += Wp[j][i] * hLast[i];
      f.logits[j] = s;
    }
    return f;
  }

  // masked softmax over legal slots
  static std::vector<double> softmax(const std::vector<double>& logits, const std::vector<bool>& legal) {
    int n = (int)logits.size();
    double mx = -1e300;
    for (int j = 0; j < n; j++) if (legal[j] && logits[j] > mx) mx = logits[j];
    std::vector<double> p(n, 0.0);
    double sum = 0;
    for (int j = 0; j < n; j++) if (legal[j]) { p[j] = std::exp(logits[j] - mx); sum += p[j]; }
    for (int j = 0; j < n; j++) if (legal[j]) p[j] /= sum;
    return p;
  }

  // one SGD step on a single example; returns the loss. pi: target visit dist (0 on illegal), z: outcome.
  double trainStep(const std::vector<double>& x, double z, const std::vector<double>& pi,
                   const std::vector<bool>& legal, double lr, double cPol = 1.0) {
    Forward f = forward(x);
    const std::vector<double>& hLast = f.acts.back();
    double v = f.v;
    std::vector<double> p = softmax(f.logits, legal);

    double dv = v - z, dzv = dv * (1 - v * v);
    std::vector<double> dlog(nPol, 0.0);
    for (int j = 0; j < nPol; j++) if (legal[j]) dlog[j] = cPol * (p[j] - pi[j]);
    // grad wrt last hidden activation (pre-update head weights)
    std::vector<double> dA(nHid);
    for (int i = 0; i < nHid; i++) {
      double s = dzv * Wv[i];
      for (int j = 0; j < nPol; j++) if (legal[j]) s += dlog[j] * Wp[j][i];
      dA[i] = s;
    }
    // update heads
    bv -= lr * dzv;
    for (int i = 0; i < nHid; i++) Wv[i] -= lr * dzv * hLast[i];
    for (int j = 0; j < nPol; j++) if (legal[j]) {
      bp[j] -= lr * dlog[j];
      for (int i = 0; i < nHid; i++) Wp[j][i] -= lr * dlog[j] * hLast[i];
    }
    // backprop hidden layers last→first (dIn from pre-update W, then update W)
    for (int l = (int)W.size() - 1; l >= 0; l--) {
      const std::vector<double>& aOut = f.acts[l + 1];
      const std::vector<double>& aIn = f.acts[l];
      int dout = (int)aOut.size(), din = (int)aIn.size();
      std::vector<double> dZ(dout);
      for (int i = 0; i < dout; i++) dZ[i] = aOut[i] > 0 ? dA[i] : 0;
      std::vector<double> dIn;
      if (l > 0) {
        dIn.assign(din, 0.0);
        for (int i = 0; i < dout; i++) { double g = dZ[i]; if (g) { const auto& Wi = W[l][i]; for (int k = 0; k < din; k++) dIn[k] += g * Wi[k]; } }
      }
      for (int i = 0; i < dout; i++) {
        double g = dZ[i];
        b[l][i] -= lr * g;
        if (g) { auto& Wi = W[l][i]; for (int k = 0; k < din; k++) Wi[k] -= lr * g * aIn[k]; }
      }
      dA = std::move(dIn);
    }
    double lp = 0;
    for (int j = 0; j < nPol; j++) if (legal[j] && pi[j] > 0) lp -= pi[j] * std::log(std::max(1e-12, p[j]));
    return 0.5 * dv * dv + cPol * lp;
  }
};

} // namespace cz
