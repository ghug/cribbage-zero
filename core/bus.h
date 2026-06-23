// bus.h — client for the Cribbage Zero data-bus Worker (worker-api), built on the HttpClient interface.
// Routes: POST /shard, GET /shards?limit, POST /prune, GET /stats. Token = the worker token (actor) or the
// trainer token (learner). Mirrors engine/az_sync.js.
#pragma once
#include "http.h"
#include "net_io.h"
#include <vector>
#include <string>

namespace cz {

struct Shard { long id; std::vector<Sample> samples; };

class BusClient {
public:
  BusClient(HttpClient* http, std::string baseUrl, std::string token)
      : http_(http), base_(std::move(baseUrl)), token_(std::move(token)) {
    while (!base_.empty() && base_.back() == '/') base_.pop_back();
  }

  bool putShard(const std::vector<Sample>& samples, const std::string& workerId) {
    json body;
    body["workerId"] = workerId;
    json arr = json::array();
    for (const auto& s : samples) arr.push_back(sampleToJson(s));
    body["samples"] = std::move(arr);
    auto r = http_->post(base_ + "/shard", body.dump(), authHeaders());
    return r.status == 200;
  }

  std::vector<Shard> getShards(int limit) {
    std::vector<Shard> out;
    auto r = http_->get(base_ + "/shards?limit=" + std::to_string(limit), authHeaders());
    if (r.status != 200) return out;
    auto j = json::parse(r.body, nullptr, false);
    if (j.is_discarded() || !j.contains("shards")) return out;
    for (const auto& sh : j["shards"]) {
      Shard shard; shard.id = sh.at("id").get<long>();
      for (const auto& s : sh.at("samples")) shard.samples.push_back(sampleFromJson(s));
      out.push_back(std::move(shard));
    }
    return out;
  }

  bool prune(const std::vector<long>& ids) {
    json body; body["ids"] = ids;
    auto r = http_->post(base_ + "/prune", body.dump(), authHeaders());
    return r.status == 200;
  }

  long stats() {
    auto r = http_->get(base_ + "/stats", authHeaders());
    if (r.status != 200) return -1;
    auto j = json::parse(r.body, nullptr, false);
    return j.is_discarded() ? -1 : j.value("pendingShards", -1L);
  }

private:
  HttpClient* http_;
  std::string base_, token_;
  std::vector<Header> authHeaders() const {
    return {{"Authorization", "Bearer " + token_}, {"Content-Type", "application/json"}};
  }
};

} // namespace cz
