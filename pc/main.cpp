// pc/main.cpp — the Cribbage Zero PC CLI (C++), replacing engine/az_contribute.js.
//   LEARNER (default): pull net -> self-play + drain bus -> replay-buffer train -> push net every N games.
//   ACTOR  (--actor):  pull net -> self-play -> upload shards to the bus -> refresh net when it advances.
//   --dry: local self-play bench only (no network, no push) — safe to run anywhere.
//   --fresh: deliberately start from a random net (OVERWRITES the net branch on push). Default is SAFE:
//            resume the existing net; start fresh ONLY on a genuine 404; ABORT on a read error / wrong arch.
// Env: CZ_REPO CZ_TOKEN CZ_BUS_URL CZ_BUS_TOKEN CZ_WORKERS CZ_PUSH_GAMES CZ_BUF CZ_BATCH CZ_SIMS CZ_CHUNK
//      CZ_SHARD_MAX CZ_REFRESH_MIN CZ_BUS_LIMIT CZ_TEMP_MOVES CZ_DIR_EPS CZ_DIR_ALPHA CZ_FPU CZ_CPUCT_BASE CZ_WD CZ_WCLAMP CZ_LR CZ_LEASE_TTL_MS CZ_MOMENTUM CZ_BRANCH CZ_SNAP_GAMES CZ_SNAP_DIR.  Args: [gamesPerRound] [sims].
#include "parallel.h"
#include "buffer.h"
#include "bus.h"
#include "actor.h"     // busFailDesc() — shared bus-failure wording
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
#include <fstream>
#include <sys/stat.h>
#include <unistd.h>

using namespace cz;

static std::atomic<bool> g_stop{false};
static void onSigint(int) { g_stop = true; }
static std::string env(const char* k, const std::string& def = "") { const char* v = getenv(k); return v ? std::string(v) : def; }
static int envi(const char* k, int def) { const char* v = getenv(k); return v && *v ? atoi(v) : def; }
static double envf(const char* k, double def) { const char* v = getenv(k); return v && *v ? atof(v) : def; }
static void log(const std::string& m) { std::printf("[cz] %s\n", m.c_str()); std::fflush(stdout); }

// Write a timestamped local recovery snapshot of the net into `dir` (created if needed). The name matches the
// snapshot.html / snapshot_net.js convention (YYYYMMDD-HHMM-<games>g-iter<iter>.json) so the rollback tooling
// reads it directly. Best-effort: warns and returns on any failure — never throws into the learner loop.
static void writeSnapshot(const std::string& dir, const Net& net, int iter, long games) {
  ::mkdir(dir.c_str(), 0755);   // idempotent; an existing dir (EEXIST) is fine
  std::time_t t = std::time(nullptr); std::tm lt{}; localtime_r(&t, &lt);
  char stamp[32]; std::strftime(stamp, sizeof stamp, "%Y%m%d-%H%M", &lt);
  char name[128]; std::snprintf(name, sizeof name, "%s/%s-%ldg-iter%d.json", dir.c_str(), stamp, games, iter);
  std::ofstream f(name, std::ios::binary);
  if (f) f << netToJson(net, iter, games).dump();
  if (!f || !f.good()) { log(std::string("WARNING: local snapshot failed -> ") + name); return; }
  log(std::string("local snapshot -> ") + name);
}

static void printHelp() {
  std::puts(
R"(Usage: cz_pc [OPTIONS] [gamesPerRound] [sims]

Cribbage Zero self-play engine. The default mode is the LEARNER: pull the net from
GitHub, self-play + train a replay buffer, drain the data bus, and push the net back.

Options:
  --actor          run as an actor: self-play -> upload sample shards to the bus
                   (no training, no net push). Requires CZ_BUS_URL + CZ_BUS_TOKEN.
  --dry            local self-play bench only (no network, no push) -- safe anywhere
  --fresh          start from a random net, OVERWRITING the net branch on first push
  -h, --help       show this help and exit

Arguments:
  gamesPerRound    self-play games per round    (default: CZ_CHUNK, else 500)
  sims             MCTS simulations per move     (default: CZ_SIMS, else 40)

Environment:
  CZ_TOKEN         GitHub PAT (Contents: write) -- required for the learner to push
  CZ_REPO          target repo                   (default ghug/cribbage-zero)
  CZ_BRANCH        net branch                    (default net)
  CZ_BUS_URL       data-bus Worker URL           (omit to run solo, no bus)
  CZ_BUS_TOKEN     bus token: trainer (learner) or worker (actor)
  CZ_WORKERS       self-play threads             (default: CPU cores - 1)
  CZ_SIMS          MCTS sims per move            (default 40)
  CZ_LR            SGD learning rate             (default 0.002)
  CZ_MOMENTUM      SGD momentum                  (default 0.9)
  CZ_WD            L2 weight decay               (default 1e-4)
  CZ_WCLAMP        clamp |weights| (anti-NaN)    (default 10; 0 = off)
  CZ_BATCH         train mini-batch size         (default 256)
  CZ_BUF           replay-buffer capacity        (default 200000)
  CZ_PUSH_GAMES    push the net every N games    (default 10000)
  CZ_SNAP_GAMES    write a LOCAL net snapshot every N games  (default 100000; 0 = off)
  CZ_SNAP_DIR      directory for local snapshots (default snapshots/)
  CZ_SHARD_MAX     samples per uploaded shard    (default 300; keep small — D1 caps the row size)
  CZ_REFRESH_MIN   actor: min minutes between net re-downloads  (default 0 = on every advance)
  CZ_BUS_LIMIT     shards drained per round      (default 400)
  CZ_LEASE_TTL_MS  learner-lease TTL in ms       (default 600000)
  CZ_TEMP_MOVES    temperature-sampled opening plies  (default 30)
  CZ_DIR_EPS       Dirichlet root-noise weight   (default 0.25)
  CZ_DIR_ALPHA     Dirichlet alpha               (default 0.8)
  CZ_FPU           first-play-urgency reduction  (default 0.25)
  CZ_CPUCT_BASE    c_puct log-scaling base       (default 19652)

Examples:
  export CZ_TOKEN=...                         # GitHub PAT (Contents: write)
  cz_pc                                       # learner, solo
  cz_pc --dry                                 # local self-play bench, no network

  export CZ_BUS_URL=https://...workers.dev    # add a data bus:
  export CZ_BUS_TOKEN=...                      #   trainer token -> learner+bus; worker token -> actor
  cz_pc                                       # learner draining the bus
  cz_pc --actor                               # actor feeding the bus)");
}

int main(int argc, char** argv) {
  bool actor = false, dry = false, fresh = false;
  std::vector<std::string> pos;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a == "--actor") actor = true;
    else if (a == "--dry") dry = true;
    else if (a == "--fresh") fresh = true;
    else if (a == "-h" || a == "--help") { printHelp(); return 0; }
    else pos.push_back(a);
  }

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
  long snapGames = (long)envi("CZ_SNAP_GAMES", 100000);   // write a local net snapshot every N games (0 = off)
  std::string snapDir = env("CZ_SNAP_DIR", "snapshots");  // directory for the local recovery snapshots
  double wd = envf("CZ_WD", 1e-4);   // L2 weight decay
  double wclamp = envf("CZ_WCLAMP", 10.0);   // clamp |weights| each mini-batch to bound the unbounded-ReLU runaway (anti-NaN); 0 = off
  // SGD learning rate. momentum (CZ_MOMENTUM, default 0.9) amplifies the effective step ~1/(1-mu) ≈ 10x, so
  // the per-sample lr must be ~10x lower than plain SGD or the ReLU hidden layers collapse (dead neurons →
  // constant output). 0.002 with mu=0.9 ≈ an effective 0.02, the pre-momentum value that trained without collapse.
  double lr = envf("CZ_LR", 0.002);
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
  GithubNet gh(&http, repo, token, env("CZ_BRANCH", "net"));
  std::unique_ptr<BusClient> bus;
  if (!busUrl.empty() && !busTok.empty()) bus.reset(new BusClient(&http, busUrl, busTok));

  // Net load — SAFE: only start fresh on a genuine 404 (or explicit --fresh). A read error or a
  // wrong-architecture net ABORTS, so a transient failure can never overwrite the live net branch.
  Net net(INPUT_DIM, HIDDEN, NPOL, 0.0, 1);
  int iter = 0; long games = 0; bool haveNet = false;
  if (fresh) {
    log("--fresh: random net (will OVERWRITE the net branch on the first push)");
  } else {
    try {
      auto n = gh.pullNet();   // nullopt = genuine 404; throws on a read error
      if (n && validNetJson(*n, INPUT_DIM, HIDDEN, NPOL)) {
        net = netFromJson(*n); iter = n->value("iter", 0); games = n->value("games", 0L); haveNet = true;
        log("resuming net iter " + std::to_string(iter) + " (" + std::to_string(games) + " games)");
      } else if (n) {
        log("FATAL: the net branch holds a different architecture (nIn " + std::to_string(n->value("nIn", -1)) +
            ") — refusing to start so we don't overwrite it. Use --fresh to reset deliberately.");
        return 1;
      } else {
        log("no net on GitHub yet (404) — bootstrapping a fresh net");
      }
    } catch (const std::exception& e) {
      log(std::string("FATAL: can't read the net (") + e.what() + ") — refusing to start so we don't overwrite the live net.");
      return 1;
    }
  }
  if (actor && !haveNet) { log("--actor needs an existing net on GitHub — start the learner first."); return 1; }
  std::string workerId = "cpp-" + std::to_string(getpid());

  if (actor) {
    if (!bus) { log("--actor needs CZ_BUS_URL + CZ_BUS_TOKEN"); return 1; }
    int shardMax = envi("CZ_SHARD_MAX", 300);
    double refreshMin = envf("CZ_REFRESH_MIN", 0);   // min minutes between net re-downloads (0 = refresh on every advance)
    auto lastRefresh = std::chrono::steady_clock::now();
    log("ACTOR: self-play -> bus");
    while (!g_stop) {
      std::vector<Sample> s;
      parallelSelfPlay(net, sims, cpuct, pairsPerRound, workers, seed++, s, tempMoves, dirEps, dirAlpha, fpu, cBase);
      long uploaded = 0, failStatus = 0; std::string failBody;
      for (size_t i = 0; i < s.size(); i += shardMax) {
        std::vector<Sample> chunk(s.begin() + i, s.begin() + std::min(s.size(), i + shardMax));
        long st = 0;
        if (bus->putShard(chunk, workerId, &st, &failBody)) uploaded += (long)chunk.size();
        else failStatus = st;
      }
      if (failStatus != 0) {   // fail loudly — don't claim an upload the bus refused; echo to stderr so it stands out
        std::string warn = "WARNING: " + busFailDesc(failStatus) + " — " + std::to_string((long)s.size() - uploaded) + " samples NOT uploaded"
                         + (failBody.empty() ? "" : " — bus said: " + failBody.substr(0, 200));
        log(warn);
        std::fprintf(stderr, "[cz] %s\n", warn.c_str()); std::fflush(stderr);
      } else {
        log("uploaded " + std::to_string(uploaded) + " samples");
      }
      auto info = gh.pullInfo();
      double sinceRefresh = std::chrono::duration<double>(std::chrono::steady_clock::now() - lastRefresh).count();
      if (info && info->second > iter && sinceRefresh >= refreshMin * 60.0) {   // throttle the multi-MB net re-download
        auto n = gh.pullNet();
        if (n && validNetJson(*n, INPUT_DIM, HIDDEN, NPOL)) { net = netFromJson(*n); iter = info->second; lastRefresh = std::chrono::steady_clock::now(); log("refreshed to iter " + std::to_string(iter)); }
      }
    }
    return 0;
  }

  if (token.empty()) { log("learner needs CZ_TOKEN (or use --dry/--actor)"); return 1; }

  // single-writer lease: only ONE learner may train + push. Acquire before training; if the bus has no lease
  // route it degrades to no-lock (with a warning); if another learner holds it, refuse to start.
  long leaseTtl = envi("CZ_LEASE_TTL_MS", 600000);
  bool usingLease = false;
  if (bus) {
    auto L = bus->acquireLease(workerId, leaseTtl);
    if (L.status == 403) { log("FATAL: CZ_BUS_TOKEN is a WORKER token — the learner needs the TRAINER token to drain the bus and hold the lease. Refusing to start."); return 1; }
    if (!L.available) log("note: bus has no learner lease (redeploy the Worker to enable it) — running WITHOUT the single-writer lock");
    else if (!L.ok) { log("FATAL: another learner holds the lease (holder " + L.holder + ") — refusing to start a second learner."); return 1; }
    else { usingLease = true; log("acquired the learner lease"); }
  }

  net.setMomentum(envf("CZ_MOMENTUM", 0.9));   // SGD momentum (learner only; allocates velocity buffers)
  ReplayBuffer buf(bufCap);
  long pushAccum = 0;
  long snapMark = snapGames > 0 ? (games / snapGames) * snapGames : 0;   // last games-boundary already snapshotted (don't re-snapshot the resume point)
  bool lostLease = false;
  log("LEARNER: self-play + train + push every " + std::to_string(pushEvery) + " games"
      + (snapGames > 0 ? ", local snapshot every " + std::to_string(snapGames) + " games -> " + snapDir + "/" : ""));
  while (!g_stop) {
    if (usingLease) {   // renew at the top of each round (TTL >> round time)
      auto L = bus->acquireLease(workerId, leaseTtl);
      if (L.available && !L.ok) { log("lost the learner lease (holder " + L.holder + ") — another learner took over; stopping WITHOUT pushing."); lostLease = true; break; }
    }
    std::vector<Sample> local;
    long played = parallelSelfPlay(net, sims, cpuct, pairsPerRound, workers, seed++, local, tempMoves, dirEps, dirAlpha, fpu, cBase);
    long newSamples = (long)local.size();
    int dropped = buf.add(local);
    std::vector<long> pruneIds;
    if (bus) {
      long drainStatus = 0;
      auto sh = bus->getShards(envi("CZ_BUS_LIMIT", 400), &drainStatus);
      if (drainStatus != 200)
        log(drainStatus == 403 ? "WARNING: bus drain FORBIDDEN (403) — CZ_BUS_TOKEN is a WORKER token; the learner needs the TRAINER token. NOT draining the bus."
            : "WARNING: bus drain failed (status " + std::to_string(drainStatus) + ") — check CZ_BUS_URL/CZ_BUS_TOKEN. NOT draining the bus.");
      for (auto& s : sh) { dropped += buf.add(s.samples); newSamples += s.samples.size(); pruneIds.push_back(s.id); }
    }
    if (dropped) log("WARNING: dropped " + std::to_string(dropped) + " non-finite/out-of-range sample(s) (bad data rejected before training)");
    int steps = std::max(1, (int)std::lround((double)trainPerSample * newSamples / batch));
    Rng tr(seed * 2654435761u);
    double loss = trainReplay(net, buf, steps, batch, lr, tr, wd, /*augment=*/true, wclamp);
    iter++; games += played; pushAccum += played;
    if (bus && !pruneIds.empty()) bus->prune(pruneIds);
    char line[160]; std::snprintf(line, sizeof line, "iter %d (%ld games): %ld samples, buf %zu, loss %.3f", iter, games, newSamples, buf.size(), loss);
    log(line);
    if (!net.finite()) { log("FATAL: net went non-finite (NaN/Inf) during training — NOT pushing (would corrupt the net branch). Stopping; restart resumes from the last good push."); break; }
    if (snapGames > 0 && games - snapMark >= snapGames) {   // crossed a snapshot boundary this round (net is finite per the check above)
      writeSnapshot(snapDir, net, iter, games);
      snapMark = (games / snapGames) * snapGames;
    }
    if (pushAccum >= pushEvery) { if (gh.pushNet(net, iter, games)) { log("pushed " + std::to_string(games) + " games"); pushAccum = 0; } else log("push failed"); }
  }
  if (!lostLease && net.finite() && gh.pushNet(net, iter, games)) log("wind-down push");   // never push a non-finite net
  if (usingLease) bus->releaseLease(workerId);
  return 0;
}
