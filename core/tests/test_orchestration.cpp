// test_orchestration.cpp — bus + GitHub clients and a full actor->bus->learner->push cycle, against an
// in-memory MockHttp (no network). Verifies the orchestration the PC CLI is built from.
#include "../bus.h"
#include "../github.h"
#include "../buffer.h"
#include "../parallel.h"
#include "../net_io.h"
#include <cstdio>
#include <map>
#include <string>

using namespace cz;
static int ok = 0, fail = 0;
static void check(bool c, const char* m) { if (c) ok++; else { fail++; std::printf("  x %s\n", m); } }

static bool has(const std::string& s, const char* sub) { return s.find(sub) != std::string::npos; }

// Minimal fake of the bus Worker + the GitHub net branch.
struct MockHttp : HttpClient {
  // bus
  std::vector<std::pair<long, json>> shards; // (id, samples-array)
  long nextId = 1;
  // github net branch
  std::string netJson, infoJson;
  bool refExists = false;
  std::map<std::string, std::string> blobs; // sha -> content
  json lastTree;
  long blobN = 0, treeN = 0, commitN = 0;

  HttpResponse request(const std::string& method, const std::string& url,
                       const std::string& body, const std::vector<Header>&) override {
    HttpResponse r; r.status = 200;
    json b = body.empty() ? json() : json::parse(body, nullptr, false);

    // ---- bus ----
    if (has(url, "/shard") && !has(url, "/shards") && method == "POST") {
      shards.push_back({nextId++, b.at("samples")}); r.body = R"({"ok":true})"; return r;
    }
    if (has(url, "/shards") && method == "GET") {
      json out; out["shards"] = json::array();
      for (auto& sh : shards) out["shards"].push_back(json{{"id", sh.first}, {"samples", sh.second}});
      r.body = out.dump(); return r;
    }
    if (has(url, "/prune") && method == "POST") {
      std::vector<long> ids = b.at("ids").get<std::vector<long>>();
      shards.erase(std::remove_if(shards.begin(), shards.end(), [&](auto& sh) {
        return std::find(ids.begin(), ids.end(), sh.first) != ids.end(); }), shards.end());
      r.body = R"({"ok":true})"; return r;
    }
    if (has(url, "/stats") && method == "GET") {
      r.body = json{{"pendingShards", (long)shards.size()}}.dump(); return r;
    }

    // ---- github ----
    if (has(url, "/contents/") && has(url, "info.json")) {
      if (infoJson.empty()) { r.status = 404; } else r.body = infoJson; return r;
    }
    if (has(url, "/contents/") && has(url, "az_checkpoint.json")) {
      if (netJson.empty()) { r.status = 404; } else r.body = netJson; return r;
    }
    if (has(url, "/git/blobs") && method == "POST") {
      std::string sha = "blob" + std::to_string(++blobN);
      // content is base64; we don't decode in the mock — we store raw and re-serve via pull only by path.
      blobs[sha] = b.at("content").get<std::string>(); r.body = json{{"sha", sha}}.dump(); return r;
    }
    if (has(url, "/git/trees") && method == "POST") {
      lastTree = b.at("tree"); r.body = json{{"sha", "tree" + std::to_string(++treeN)}}.dump(); return r;
    }
    if (has(url, "/git/commits") && method == "POST") {
      r.body = json{{"sha", "commit" + std::to_string(++commitN)}}.dump(); return r;
    }
    if (has(url, "/git/ref/heads/net") && method == "GET") {
      r.status = refExists ? 200 : 404; r.body = "{}"; return r;
    }
    if ((has(url, "/git/refs") || has(url, "/git/ref/heads/net")) && (method == "POST" || method == "PATCH")) {
      // apply the push: decode base64 blobs referenced by the last tree into the net/info files
      for (auto& e : lastTree) {
        std::string path = e.at("path"), sha = e.at("sha");
        std::string content = b64decode(blobs[sha]);
        if (has(path, "az_checkpoint.json")) netJson = content;
        else if (has(path, "info.json")) infoJson = content;
      }
      refExists = true; r.body = "{}"; return r;
    }
    r.status = 404; r.body = "{}"; return r;
  }

  static std::string b64decode(const std::string& in) {
    auto val = [](char c) -> int {
      if (c >= 'A' && c <= 'Z') return c - 'A';
      if (c >= 'a' && c <= 'z') return c - 'a' + 26;
      if (c >= '0' && c <= '9') return c - '0' + 52;
      if (c == '+') return 62; if (c == '/') return 63; return -1;
    };
    std::string out; int bits = 0, acc = 0;
    for (char c : in) { int v = val(c); if (v < 0) continue; acc = (acc << 6) | v; bits += 6; if (bits >= 8) { bits -= 8; out.push_back((char)((acc >> bits) & 0xFF)); } }
    return out;
  }
};

int main() {
  MockHttp mock;
  BusClient bus(&mock, "http://bus", "worker-tok");
  GithubNet gh(&mock, "ghug/cribbage-zero", "trainer-tok");

  // produce some self-play samples (parallel)
  Net net(INPUT_DIM, {24}, NPOL, 0.0, /*seed=*/9);
  std::vector<Sample> samples;
  long games = parallelSelfPlay(net, 12, 1.5, /*pairs=*/6, /*threads=*/3, 123u, samples);
  check(games == 12, "parallel self-play played 6 pairs = 12 games");
  check(!samples.empty(), "parallel self-play produced samples");

  // ---- bus round-trip ----
  check(bus.putShard(samples, "wid-1"), "putShard ok");
  check(bus.stats() == 1, "stats sees 1 pending shard");
  auto drained = bus.getShards(100);
  check(drained.size() == 1 && drained[0].samples.size() == samples.size(), "getShards returns the shard intact");
  // samples survive the wire (within 3dp)
  bool sOk = true; for (size_t i = 0; i < samples.size(); i++) if (drained[0].samples[i].z != samples[i].z) sOk = false;
  check(sOk, "drained sample z values match");
  check(bus.prune({drained[0].id}), "prune ok");
  check(bus.stats() == 0, "stats empty after prune");

  // ---- github push/pull round-trip ----
  check(!gh.pullInfo().has_value(), "no net on the branch yet (pullInfo empty)");
  // train a touch so the net differs from random, then push
  ReplayBuffer rb(100000);
  rb.add(samples);
  Rng tr(1);
  double l0 = trainReplay(net, rb, 50, 64, 0.02, tr);
  check(l0 > 0, "trainReplay ran");
  check(gh.pushNet(net, /*iter=*/3, /*games=*/600), "pushNet ok");
  auto info = gh.pullInfo();
  check(info && info->first == 600 && info->second == 3, "pullInfo reflects the push (games/iter)");
  auto pulled = gh.pullNet();
  check(pulled.has_value(), "pullNet returns the pushed net");
  if (pulled) {
    Net back = netFromJson(*pulled);
    Rng rr(7); std::vector<double> x(INPUT_DIM); for (auto& v : x) v = rr.next();
    double d = std::fabs(net.forward(x).v - back.forward(x).v);
    check(d < 1e-9, "pushed net round-trips through GitHub bit-for-bit");
  }

  // ---- end-to-end: actor uploads, learner drains + trains + pushes a newer net ----
  std::vector<Sample> more;
  parallelSelfPlay(net, 12, 1.5, 4, 2, 555u, more);
  bus.putShard(more, "wid-2");
  auto sh = bus.getShards(100);
  check(!sh.empty(), "learner drains the actor's upload");
  ReplayBuffer rb2(200000);
  for (auto& s : sh) rb2.add(s.samples);
  double before = trainReplay(net, rb2, 1, 32, 0.0, tr);  // 0-lr → just measures loss
  Rng tr2(2);
  for (int it = 0; it < 30; it++) trainReplay(net, rb2, 1, 64, 0.02, tr2);
  double after = trainReplay(net, rb2, 1, 32, 0.0, tr2);
  check(after < before, "learner training reduces loss on the drained samples");
  check(gh.pushNet(net, 4, 1200), "learner pushes the updated net");
  check(gh.pullInfo()->second == 4, "branch now at the learner's iter 4");

  std::printf("\norchestration test: %d passed, %d failed (%zu samples)\n", ok, fail, samples.size());
  return fail ? 1 : 0;
}
