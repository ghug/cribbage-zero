// actor.h — the shared "actor" loop: pull the net, then self-play -> upload sample shards -> refresh the
// net when the learner advances it, until a stop flag is set. Pure C++ on the injected HttpClient (no curl,
// no JNI), so it runs identically behind libcurl (PC) and the Android JNI->Java HTTP bridge, and is unit-
// tested against the in-memory MockHttp. The PC CLI keeps its own inlined learner+actor loop; this is the
// reusable actor used by the Android native worker.
#pragma once
#include "parallel.h"
#include "github.h"
#include "bus.h"
#include "net_io.h"
#include <atomic>
#include <functional>
#include <string>
#include <vector>
#include <algorithm>
#include <chrono>

namespace cz {

struct ActorConfig {
  std::string repo = "ghug/cribbage-zero";
  std::string busUrl, busToken;     // bus URL + worker token (required to upload)
  std::string token;                // GitHub token — optional (anonymous public net read works)
  std::string branch = "net";
  std::string workerId = "actor";
  int sims = 40, workers = 2, pairsPerRound = 20, shardMax = 1500;
  int refreshMinSec = 0;            // throttle: min seconds between net re-downloads (0 = refresh on every advance)
  uint32_t seed = 12345;
};

// Human-readable reason a shard upload was rejected, by HTTP status (mirrors the learner's drain warnings).
inline std::string busFailDesc(long status) {
  if (status == 401 || status == 403)
    return "bus REJECTED the upload (status " + std::to_string(status) + ") — CZ_BUS_TOKEN is missing or not a valid worker token";
  if (status < 0) return "bus UNREACHABLE — check CZ_BUS_URL and the network connection";
  return "bus upload FAILED (status " + std::to_string(status) + ")";
}

// Runs until `stop` is set. Returns games played (>=0), or -1 on a fatal start condition (no readable net).
// `log` receives human-readable progress lines. `notify` (optional) receives only the loud, escalated bus-
// failure alerts — wire it on platforms that want a distinct alert (e.g. an Android heads-up notification);
// leave it null to route alerts through `log` alone. The architecture is fixed to the learner's {256x4}.
inline long runActorLoop(HttpClient& http, const ActorConfig& cfg, std::atomic<bool>& stop,
                         const std::function<void(const std::string&)>& log,
                         const std::function<void(const std::string&)>& notify = nullptr) {
  const std::vector<int> HIDDEN = {256, 256, 256, 256};
  GithubNet gh(&http, cfg.repo, cfg.token, cfg.branch);
  Net net(INPUT_DIM, HIDDEN, NPOL, 0.0, 1);
  int iter = 0;
  try {
    auto n = gh.pullNet();   // nullopt = genuine 404; throws on a read error
    if (n && validNetJson(*n, INPUT_DIM, HIDDEN, NPOL)) { net = netFromJson(*n); iter = n->value("iter", 0); }
    else if (n) { log("net on GitHub has a different architecture — refusing to actor for it"); return -1; }
    else { log("no net on GitHub yet — start the learner first"); return -1; }
  } catch (const std::exception& e) { log(std::string("can't read the net: ") + e.what()); return -1; }
  log("actor: starting from net iter " + std::to_string(iter));

  BusClient bus(&http, cfg.busUrl, cfg.busToken);
  long total = 0;
  uint32_t seed = cfg.seed;
  int w = cfg.workers > 0 ? cfg.workers : 2;
  int pr = cfg.pairsPerRound > 0 ? cfg.pairsPerRound : 20;
  int sm = cfg.shardMax > 0 ? cfg.shardMax : 1500;
  auto lastRefresh = std::chrono::steady_clock::now();
  bool prevFailed = false;   // edge-trigger the escalated alert: notify on the FIRST failing round, not every one

  while (!stop) {
    std::vector<Sample> s;
    parallelSelfPlay(net, cfg.sims > 0 ? cfg.sims : 40, 1.5, pr, w, seed++, s,
                     /*tempMoves=*/30, /*dirEps=*/0.25, /*dirAlpha=*/0.8, /*fpu=*/0.25, /*cBase=*/19652.0);
    total += (long)pr * 2;
    long uploaded = 0, failStatus = 0;
    for (size_t i = 0; i < s.size() && !stop; i += (size_t)sm) {
      std::vector<Sample> chunk(s.begin() + i, s.begin() + std::min(s.size(), i + (size_t)sm));
      long st = 0;
      if (bus.putShard(chunk, cfg.workerId, &st)) uploaded += (long)chunk.size();
      else failStatus = st;
    }
    if (failStatus != 0) {   // fail loudly: don't report a phantom "uploaded" when the bus refused the samples
      std::string msg = "WARNING: " + busFailDesc(failStatus) + " — " + std::to_string((long)s.size() - uploaded)
                      + " samples NOT uploaded (" + std::to_string(total) + " games self-played so far)";
      log(msg);
      if (notify && !prevFailed) notify(msg);   // optional escalated alert, only on the rising edge (no per-round spam)
      prevFailed = true;
    } else {
      log("uploaded " + std::to_string(uploaded) + " samples (" + std::to_string(total) + " games so far)");
      prevFailed = false;
    }
    try {   // refresh the net if the learner advanced it (cheap info probe first), throttled to bound data use
      auto info = gh.pullInfo();
      double sinceRefresh = std::chrono::duration<double>(std::chrono::steady_clock::now() - lastRefresh).count();
      if (info && info->second > iter && sinceRefresh >= cfg.refreshMinSec) {
        auto n = gh.pullNet();   // the multi-MB net — only re-downloaded past the throttle window
        if (n && validNetJson(*n, INPUT_DIM, HIDDEN, NPOL)) { net = netFromJson(*n); iter = info->second; lastRefresh = std::chrono::steady_clock::now(); log("refreshed to net iter " + std::to_string(iter)); }
      }
    } catch (...) { /* a transient refresh failure is non-fatal — keep self-playing on the current net */ }
  }
  return total;
}

} // namespace cz
