// net.h — value+policy MLP for the AlphaZero loop. Templated on the scalar type so production runs f32
// (flat contiguous weights → wide SIMD) while the gradient-check test uses NetT<double> for rigor.
// Stack of ReLU hidden layers → two heads: scalar VALUE (tanh) + POLICY logits (softmax over legal slots).
// loss = 1/2 (v - z)^2 + cPol * cross-entropy(softmax(logits)_legal, pi). Math ports engine/az_net.js.
#pragma once
#include "rng.h"
#include <vector>
#include <cmath>
#include <algorithm>

namespace cz {

template <class T>
struct ForwardT {
  std::vector<std::vector<T>> acts; // acts[l] = input to layer l (acts[0]=x); acts.back() = last hidden
  T v = 0;
  std::vector<T> logits;
};

template <class T>
class NetT {
public:
  int nIn, nPol, nHid;
  std::vector<int> hidden;
  std::vector<int> din_, dout_;          // per hidden layer
  std::vector<std::vector<T>> W;          // W[l]: flat dout_*din_ (row-major)
  std::vector<std::vector<T>> b;          // b[l]: dout_
  std::vector<T> Wv; T bv = 0;            // value head: nHid
  std::vector<T> Wp;                       // policy head: flat nPol*nHid
  std::vector<T> bp;                       // nPol

  NetT() : nIn(0), nPol(0), nHid(0) {}

  // seedW>0 → U(-seedW,seedW) (gradient check); else He-uniform via rng.
  NetT(int nIn_, std::vector<int> hidden_, int nPol_, double seedW = 0.0, uint32_t seed = 1)
      : nIn(nIn_), nPol(nPol_), hidden(std::move(hidden_)) {
    nHid = hidden.back();
    Rng rng(seed);
    auto randu = [&](double r) { return (T)((rng.next() * 2.0 - 1.0) * r); };
    int prev = nIn;
    for (size_t l = 0; l < hidden.size(); l++) {
      int din = prev, dout = hidden[l];
      din_.push_back(din); dout_.push_back(dout);
      double r = seedW > 0 ? seedW : std::sqrt(6.0 / din);
      std::vector<T> w((size_t)dout * din);
      for (auto& x : w) x = randu(r);
      W.push_back(std::move(w));
      b.emplace_back(dout, T(0));
      prev = dout;
    }
    double rh = seedW > 0 ? seedW : std::sqrt(6.0 / nHid);
    Wv.resize(nHid); for (auto& x : Wv) x = randu(rh);
    Wp.resize((size_t)nPol * nHid); for (auto& x : Wp) x = randu(rh);
    bp.assign(nPol, T(0));
  }

  ForwardT<T> forward(const std::vector<T>& x) const {
    ForwardT<T> f;
    f.acts.push_back(x);
    std::vector<T> a = x;
    for (size_t l = 0; l < W.size(); l++) {
      int dout = dout_[l], din = din_[l];
      const T* Wl = W[l].data();
      const T* bl = b[l].data();
      const T* ap = a.data();
      std::vector<T> o(dout);
      int i = 0;
      // 4-way row blocking over the flat layer: each a[k] loaded once, fanned across 4 output rows.
      for (; i + 4 <= dout; i += 4) {
        const T* r0 = Wl + (size_t)i * din; const T* r1 = r0 + din; const T* r2 = r1 + din; const T* r3 = r2 + din;
        T s0 = bl[i], s1 = bl[i + 1], s2 = bl[i + 2], s3 = bl[i + 3];
        for (int k = 0; k < din; k++) { T ak = ap[k]; s0 += r0[k] * ak; s1 += r1[k] * ak; s2 += r2[k] * ak; s3 += r3[k] * ak; }
        o[i] = s0 > 0 ? s0 : 0; o[i + 1] = s1 > 0 ? s1 : 0; o[i + 2] = s2 > 0 ? s2 : 0; o[i + 3] = s3 > 0 ? s3 : 0;
      }
      for (; i < dout; i++) { const T* ri = Wl + (size_t)i * din; T s = bl[i]; for (int k = 0; k < din; k++) s += ri[k] * ap[k]; o[i] = s > 0 ? s : 0; }
      a = std::move(o);
      f.acts.push_back(a);
    }
    const std::vector<T>& h = f.acts.back();
    double zv = bv; for (int i = 0; i < nHid; i++) zv += (double)Wv[i] * h[i];
    f.v = (T)std::tanh(zv);
    f.logits.assign(nPol, T(0));
    for (int j = 0; j < nPol; j++) { double s = bp[j]; const T* Wj = Wp.data() + (size_t)j * nHid; for (int i = 0; i < nHid; i++) s += (double)Wj[i] * h[i]; f.logits[j] = (T)s; }
    return f;
  }

  // inference-only forward (NO acts allocation): ping-pong scratch buffers sa/sb (auto-resized), writes
  // value into vOut and logits into logitsOut. The MCTS hot path uses this (forward() keeps acts for training).
  void infer(const std::vector<T>& x, std::vector<T>& sa, std::vector<T>& sb,
             std::vector<T>& logitsOut, T& vOut) const {
    const T* ap = x.data();
    int din = nIn;
    std::vector<T>* outv = &sa; std::vector<T>* otherv = &sb;
    for (size_t l = 0; l < W.size(); l++) {
      int dout = dout_[l];
      outv->resize(dout);
      const T* Wl = W[l].data(); const T* bl = b[l].data(); T* o = outv->data();
      int i = 0;
      for (; i + 4 <= dout; i += 4) {
        const T* r0 = Wl + (size_t)i * din; const T* r1 = r0 + din; const T* r2 = r1 + din; const T* r3 = r2 + din;
        T s0 = bl[i], s1 = bl[i + 1], s2 = bl[i + 2], s3 = bl[i + 3];
        for (int k = 0; k < din; k++) { T ak = ap[k]; s0 += r0[k] * ak; s1 += r1[k] * ak; s2 += r2[k] * ak; s3 += r3[k] * ak; }
        o[i] = s0 > 0 ? s0 : 0; o[i + 1] = s1 > 0 ? s1 : 0; o[i + 2] = s2 > 0 ? s2 : 0; o[i + 3] = s3 > 0 ? s3 : 0;
      }
      for (; i < dout; i++) { const T* ri = Wl + (size_t)i * din; T s = bl[i]; for (int k = 0; k < din; k++) s += ri[k] * ap[k]; o[i] = s > 0 ? s : 0; }
      ap = o; din = dout;
      std::swap(outv, otherv);
    }
    const T* h = ap;   // last hidden (in whichever buffer we wrote last)
    double zv = bv; for (int i = 0; i < nHid; i++) zv += (double)Wv[i] * h[i];
    vOut = (T)std::tanh(zv);
    logitsOut.resize(nPol);
    for (int j = 0; j < nPol; j++) { double s = bp[j]; const T* Wj = Wp.data() + (size_t)j * nHid; for (int i = 0; i < nHid; i++) s += (double)Wj[i] * h[i]; logitsOut[j] = (T)s; }
  }

  static std::vector<T> softmax(const std::vector<T>& logits, const std::vector<bool>& legal) {
    int n = (int)logits.size();
    double mx = -1e300;
    for (int j = 0; j < n; j++) if (legal[j] && logits[j] > mx) mx = logits[j];
    std::vector<T> p(n, T(0));
    double sum = 0;
    for (int j = 0; j < n; j++) if (legal[j]) { double e = std::exp((double)logits[j] - mx); p[j] = (T)e; sum += e; }
    for (int j = 0; j < n; j++) if (legal[j]) p[j] = (T)((double)p[j] / sum);
    return p;
  }

  // one SGD step on a single example; returns the loss.
  double trainStep(const std::vector<T>& x, double z, const std::vector<T>& pi,
                   const std::vector<bool>& legal, double lr, double cPol = 1.0) {
    ForwardT<T> f = forward(x);
    const std::vector<T>& h = f.acts.back();
    double v = f.v;
    std::vector<T> p = softmax(f.logits, legal);

    double dv = v - z, dzv = dv * (1 - v * v);
    std::vector<double> dlog(nPol, 0.0);
    for (int j = 0; j < nPol; j++) if (legal[j]) dlog[j] = cPol * ((double)p[j] - (double)pi[j]);
    std::vector<double> dA(nHid);
    for (int i = 0; i < nHid; i++) {
      double s = dzv * (double)Wv[i];
      for (int j = 0; j < nPol; j++) if (legal[j]) s += dlog[j] * (double)Wp[(size_t)j * nHid + i];
      dA[i] = s;
    }
    // update heads
    bv -= (T)(lr * dzv);
    for (int i = 0; i < nHid; i++) Wv[i] -= (T)(lr * dzv * (double)h[i]);
    for (int j = 0; j < nPol; j++) if (legal[j]) {
      bp[j] -= (T)(lr * dlog[j]);
      T* Wj = Wp.data() + (size_t)j * nHid;
      for (int i = 0; i < nHid; i++) Wj[i] -= (T)(lr * dlog[j] * (double)h[i]);
    }
    // backprop hidden layers last→first
    for (int l = (int)W.size() - 1; l >= 0; l--) {
      const std::vector<T>& aOut = f.acts[l + 1];
      const std::vector<T>& aIn = f.acts[l];
      int dout = dout_[l], din = din_[l];
      std::vector<double> dZ(dout);
      for (int i = 0; i < dout; i++) dZ[i] = aOut[i] > 0 ? dA[i] : 0;
      std::vector<double> dIn;
      T* Wl = W[l].data();
      if (l > 0) {
        dIn.assign(din, 0.0);
        for (int i = 0; i < dout; i++) { double g = dZ[i]; if (g) { const T* ri = Wl + (size_t)i * din; for (int k = 0; k < din; k++) dIn[k] += g * (double)ri[k]; } }
      }
      for (int i = 0; i < dout; i++) {
        double g = dZ[i];
        b[l][i] -= (T)(lr * g);
        if (g) { T* ri = Wl + (size_t)i * din; for (int k = 0; k < din; k++) ri[k] -= (T)(lr * g * (double)aIn[k]); }
      }
      dA = std::move(dIn);
    }
    double lp = 0;
    for (int j = 0; j < nPol; j++) if (legal[j] && pi[j] > 0) lp -= (double)pi[j] * std::log(std::max(1e-12, (double)p[j]));
    return 0.5 * dv * dv + cPol * lp;
  }
};

using Net = NetT<float>;        // production: f32 flat weights (wide SIMD)
using Forward = ForwardT<float>;

} // namespace cz
