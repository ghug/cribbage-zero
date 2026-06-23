// pc/main.cpp — the Cribbage Zero PC CLI (C++), replacing engine/az_contribute.js.
//   LEARNER (default): pull net -> self-play + drain bus -> replay-buffer train -> push net every N games.
//   ACTOR  (--actor):  pull net -> self-play -> upload shards to the bus -> refresh net when it advances.
//   --dry: local self-play bench only (no network, no push) — safe to run anywhere.
// Env: CZ_REPO CZ_TOKEN CZ_BUS_URL CZ_BUS_TOKEN CZ_WORKERS CZ_PUSH_GAMES CZ_BUF CZ_BATCH CZ_SIMS CZ_CHUNK
//      CZ_SHARD_MAX CZ_BUS_LIMIT CZ_TEMP_MOVES CZ_DIR_EPS CZ_DIR_ALPHA CZ_FPU CZ_CPUCT_BASE CZ_WD.  Args: [gamesPerRound] [sims].
#include "parallel.h"
#include "buffer.h"
#include "bus.h"
#include "github.h"
#include "http_curl.h"
#include "net_io.h"
#include <cstdio>
#include <cstdlib>
#include <csignal>
#include <cmath>
#include <atomic>
#include <chrono>
#include <memory>
#include <thread>
#include <ctime>
#include <unistd.h>

using namespace cz;

static std::atomic<bool> g_stop{false};
static void onSigint(int) { g_stop = true; }
static std::string env(const char* k, const std::string& def = "") { const char* v = getenv(k); return v ? std::string(v) : def; }
static int envi(const char* k, int def) { const char* v = getenv(k); return v && *v ? atoi(v) : def; }
static double envf(const char* k, double def) { const char* v = getenv(k); return v && *v ? atof(v) : def; }
static void log(const std::string& m) { std::printf("[cz] %s\n", m.c_str()); std::fflush(stdout); }

int main(int argc, char** argv) {
  bool actor = false, dry = false;
  std::vector<std::string> pos;
  for (int i = 1; i < argc; i++) { std::string a = argv[i]; if (a == "--actor") actor = true; else if (a == "--dry") dry = true; else pos.push_back(a); }

  const std::vector<int> HIDDEN = {256, 256, 256, 256};
  int gamesPerRound = pos.size() > 0 ? atoi(pos[0].c_str()) : envi("CZ_CHUNK", 500);
  int sims = pos.size() > 1 ? atoi(pos[1].c_str()) : envi("CZ_SIMS", 40);
  int pairsPerRound = std::max(1, gamesPerRound / 2);
  double cpuct = 1.5;
  // AlphaZero self-play exploration: Dirichlet root noise + temperature move-sampling for the opening plies.
  int tempMoves = envi("CZ_TEMP_MOVES", 30);
  double dirEps = envf("CZ_DIR_EPS", 0.25), dirAlpha = envf("CZ_DIR_ALPHA", 0.8);
  double fpu = envf("CZ_FPU", 0.25), cBase = envf("CZ_CPUCT_BASE", 19652.0);   // FPU reduction; c_puct log-scaling base
  int workers = envi("CZ_WORKERS", std::max(1, (int)std::thread::hardware_concurrency() - 1));
  std::string repo = env("CZ_REPO", "ghug/cribbage-zero"), token = env("CZ_TOKEN");
  std::string busUrl = env("CZ_BUS_URL"), busTok = env("CZ_BUS_TOKEN");
  int pushEvery = envi("CZ_PUSH_GAMES", 10000), bufCap = envi("CZ_BUF", 200000), batch = envi("CZ_BATCH", 256);
  double wd = envf("CZ_WD", 1e-4);   // L2 weight decay
  const int trainPerSample = 2;
  uint32_t seed = (uint32_t)time(nullptr) ^ (uint32_t)getpid();
  signal(SIGINT, onSigint);

  if (dry) {
    Net net(INPUT_DIM, HIDDEN, NPOL, 0.0, 1);
    log("DRY local self-play: " + std::to_string(pairsPerRound) + " pairs, sims " + std::to_string(sims) + ", workers " + std::to_string(workers));
    auto t0 = std::chrono::steady_clock::now();
    std::vector<Sample> s;
    long g = parallelSelfPlay(net, sims, cpuct, pairsPerRound, workers, seed, s, tempMoves, dirEps, dirAlpha, fpu, cBase);
    double dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    char buf[128]; std::snprintf(buf, sizeof buf, "%ld games, %zu samples, %.2fs = %.2f g/s", g, s.size(), dt, g / dt);
    log(buf);
    return 0;
  }

  HttpCurl http;
  GithubNet gh(&http, repo, token);
  std::unique_ptr<BusClient> bus;
  if (!busUrl.empty() && !busTok.empty()) bus.reset(new BusClient(&http, busUrl, busTok));

  Net net(INPUT_DIM, HIDDEN, NPOL, 0.0, 1);
  int iter = 0; long games = 0;
  { auto n = gh.pullNet();
    if (n && validNetJson(*n, INPUT_DIM, HIDDEN, NPOL)) { net = netFromJson(*n); iter = n->value("iter", 0); games = n->value("games", 0L); log("resuming net iter " + std::to_string(iter) + " (" + std::to_string(games) + " games)"); }
    else log("fresh net"); }
  std::string workerId = "cpp-" + std::to_string(getpid());

  if (actor) {
    if (!bus) { log("--actor needs CZ_BUS_URL + CZ_BUS_TOKEN"); return 1; }
    int shardMax = envi("CZ_SHARD_MAX", 1500);
    log("ACTOR: self-play -> bus");
    while (!g_stop) {
      std::vector<Sample> s;
      parallelSelfPlay(net, sims, cpuct, pairsPerRound, workers, seed++, s, tempMoves, dirEps, dirAlpha, fpu, cBase);
      for (size_t i = 0; i < s.size(); i += shardMax) {
        std::vector<Sample> chunk(s.begin() + i, s.begin() + std::min(s.size(), i + shardMax));
        bus->putShard(chunk, workerId);
      }
      log("uploaded " + std::to_string(s.size()) + " samples");
      auto info = gh.pullInfo();
      if (info && info->second > iter) { auto n = gh.pullNet(); if (n && validNetJson(*n, INPUT_DIM, HIDDEN, NPOL)) { net = netFromJson(*n); iter = info->second; log("refreshed to iter " + std::to_string(iter)); } }
    }
    return 0;
  }

  if (token.empty()) { log("learner needs CZ_TOKEN (or use --dry/--actor)"); return 1; }
  ReplayBuffer buf(bufCap);
  long pushAccum = 0;
  log("LEARNER: self-play + train + push every " + std::to_string(pushEvery) + " games");
  while (!g_stop) {
    std::vector<Sample> local;
    long played = parallelSelfPlay(net, sims, cpuct, pairsPerRound, workers, seed++, local, tempMoves, dirEps, dirAlpha, fpu, cBase);
    long newSamples = (long)local.size();
    buf.add(local);
    std::vector<long> pruneIds;
    if (bus) { auto sh = bus->getShards(envi("CZ_BUS_LIMIT", 400)); for (auto& s : sh) { buf.add(s.samples); newSamples += s.samples.size(); pruneIds.push_back(s.id); } }
    int steps = std::max(1, (int)std::lround((double)trainPerSample * newSamples / batch));
    Rng tr(seed * 2654435761u);
    double loss = trainReplay(net, buf, steps, batch, 0.02, tr, wd, /*augment=*/true);
    iter++; games += played; pushAccum += played;
    if (bus && !pruneIds.empty()) bus->prune(pruneIds);
    char line[160]; std::snprintf(line, sizeof line, "iter %d (%ld games): %ld samples, buf %zu, loss %.3f", iter, games, newSamples, buf.size(), loss);
    log(line);
    if (pushAccum >= pushEvery) { if (gh.pushNet(net, iter, games)) { log("pushed " + std::to_string(games) + " games"); pushAccum = 0; } else log("push failed"); }
  }
  if (gh.pushNet(net, iter, games)) log("wind-down push");
  return 0;
}
