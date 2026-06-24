// test_actor.cpp — the shared actor loop (core/actor.h) against the in-memory MockHttp: it pulls the seeded
// net, self-plays, and uploads shards to the mock bus; one round then stop. Also checks the no-net path.
#include "../actor.h"
#include "../net_io.h"
#include <cstdio>
#include <map>
#include <atomic>
#include <string>
#include <algorithm>

using namespace cz;
static int ok = 0, fail = 0;
static void check(bool c, const char* m) { if (c) ok++; else { fail++; std::printf("  x %s\n", m); } }
static bool has(const std::string& s, const char* sub) { return s.find(sub) != std::string::npos; }

// Minimal fake of the bus + the GitHub net branch (read paths the actor uses + shard intake).
struct MockHttp : HttpClient {
  std::string netJson, infoJson;
  std::vector<json> shards;
  long shardStatus = 200;   // override to simulate a rejecting/unreachable bus on POST /shard
  HttpResponse request(const std::string& method, const std::string& url,
                       const std::string& body, const std::vector<Header>&) override {
    HttpResponse r; r.status = 200;
    json b = body.empty() ? json() : json::parse(body, nullptr, false);
    if (has(url, "/shard") && !has(url, "/shards") && method == "POST") {
      if (shardStatus != 200) { r.status = shardStatus; r.body = R"({"error":"forbidden"})"; return r; }
      shards.push_back(b.at("samples")); r.body = R"({"ok":true})"; return r;
    }
    if (has(url, "/contents/") && has(url, "info.json")) { if (infoJson.empty()) r.status = 404; else r.body = infoJson; return r; }
    if (has(url, "/contents/") && has(url, "az_checkpoint.json")) { if (netJson.empty()) r.status = 404; else r.body = netJson; return r; }
    r.status = 404; r.body = "{}"; return r;
  }
};

int main() {
  // 1) happy path: a net is published -> the actor plays a round and uploads shards
  {
    MockHttp mock;
    Net seed(INPUT_DIM, {256, 256, 256, 256}, NPOL, 0.0, 1);
    mock.netJson = netToJson(seed, /*iter=*/5, /*games=*/1000).dump();
    mock.infoJson = json{{"games", 1000}, {"iter", 5}}.dump();

    ActorConfig cfg;
    cfg.busUrl = "http://bus"; cfg.busToken = "wtok"; cfg.workerId = "test";
    cfg.sims = 8; cfg.workers = 2; cfg.pairsPerRound = 3; cfg.shardMax = 400;

    std::atomic<bool> stop{false};
    int uploads = 0;
    auto log = [&](const std::string& m) { if (has(m, "uploaded")) { uploads++; stop = true; } };
    long total = runActorLoop(mock, cfg, stop, log);

    check(total >= 6, "actor played at least one round (>=3 pairs)");
    check(uploads == 1, "exactly one upload round before stop");
    check(!mock.shards.empty(), "actor uploaded shards to the bus");
    size_t n = 0; for (auto& sh : mock.shards) n += sh.size();
    check(n > 0, "uploaded shards carry samples");
  }

  // 2) no net yet -> the actor refuses to start (returns -1, uploads nothing)
  {
    MockHttp mock;   // empty netJson => 404
    ActorConfig cfg; cfg.busUrl = "http://bus"; cfg.busToken = "wtok"; cfg.pairsPerRound = 2;
    std::atomic<bool> stop{false};
    bool sawNoNet = false;
    long total = runActorLoop(mock, cfg, stop, [&](const std::string& m) { if (has(m, "no net")) sawNoNet = true; });
    check(total == -1, "actor returns -1 when there is no net");
    check(sawNoNet, "actor logs the no-net reason");
    check(mock.shards.empty(), "actor uploads nothing without a net");
  }

  // 3) bus rejects the upload (403) -> fail loudly: a WARNING (not a phantom "uploaded"), and notify fires
  {
    MockHttp mock;
    Net seed(INPUT_DIM, {256, 256, 256, 256}, NPOL, 0.0, 1);
    mock.netJson = netToJson(seed, 5, 1000).dump();
    mock.infoJson = json{{"games", 1000}, {"iter", 5}}.dump();
    mock.shardStatus = 403;   // worker token rejected

    ActorConfig cfg; cfg.busUrl = "http://bus"; cfg.busToken = "bad"; cfg.workerId = "test";
    cfg.sims = 8; cfg.workers = 2; cfg.pairsPerRound = 3; cfg.shardMax = 400;

    std::atomic<bool> stop{false};
    bool sawWarning = false, sawPhantomUpload = false, notified = false;
    auto log = [&](const std::string& m) {
      if (has(m, "WARNING") && has(m, "REJECTED")) { sawWarning = true; stop = true; }
      if (has(m, "uploaded") && !has(m, "WARNING")) sawPhantomUpload = true;   // the success line ("uploaded N"), never the "NOT uploaded" warning
    };
    auto notify = [&](const std::string& m) { if (has(m, "REJECTED")) notified = true; };
    runActorLoop(mock, cfg, stop, log, notify);

    check(sawWarning, "actor warns loudly when the bus rejects the upload (403)");
    check(!sawPhantomUpload, "actor does NOT report a phantom 'uploaded' on rejection");
    check(notified, "the optional notify callback fires on bus failure");
    check(mock.shards.empty(), "no shards were accepted by the rejecting bus");
  }

  std::printf("\nactor test: %d passed, %d failed\n", ok, fail);
  return fail ? 1 : 0;
}
