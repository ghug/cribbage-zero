// github.h — GitHub `net` branch client (pull/push), built on HttpClient. Mirrors az_contribute.js:
// reads the net + info via the RAW media type; pushes via an orphan force-push (blob → tree → commit → ref),
// so the branch always holds exactly one commit. Token optional for reads (anonymous public), required to push.
#pragma once
#include "http.h"
#include "net_io.h"
#include <optional>
#include <string>

namespace cz {

inline std::string base64(const std::string& in) {
  static const char* T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out; int val = 0, bits = -6;
  for (unsigned char c : in) {
    val = (val << 8) + c; bits += 8;
    while (bits >= 0) { out.push_back(T[(val >> bits) & 0x3F]); bits -= 6; }
  }
  if (bits > -6) out.push_back(T[((val << 8) >> (bits + 8)) & 0x3F]);
  while (out.size() % 4) out.push_back('=');
  return out;
}

class GithubNet {
public:
  GithubNet(HttpClient* http, std::string repo, std::string token)
      : http_(http), repo_(std::move(repo)), token_(std::move(token)) {}

  static constexpr const char* BRANCH = "net";
  static constexpr const char* CKPATH = "checkpoints/az_checkpoint.json";
  static constexpr const char* INFOPATH = "checkpoints/info.json";

  std::optional<std::pair<long, int>> pullInfo() {
    auto r = http_->get(contents(INFOPATH), rawHeaders());
    if (r.status != 200) return std::nullopt;
    auto j = json::parse(r.body, nullptr, false);
    if (j.is_discarded()) return std::nullopt;
    return std::make_pair(j.value("games", 0L), j.value("iter", 0));
  }

  std::optional<json> pullNet() {
    auto r = http_->get(contents(CKPATH), rawHeaders());
    if (r.status == 404) return std::nullopt;
    if (r.status != 200) return std::nullopt;
    auto j = json::parse(r.body, nullptr, false);
    if (j.is_discarded()) return std::nullopt;
    return j;
  }

  // orphan force-push of the net + info file. Returns true on success.
  bool pushNet(const Net& net, int iter, long games) {
    std::string netJson = netToJson(net, iter, games).dump();
    json info; info["games"] = games; info["iter"] = iter;

    std::string netSha = blob(netJson);
    std::string infoSha = blob(info.dump());
    if (netSha.empty() || infoSha.empty()) return false;

    json tree;
    tree["tree"] = json::array({
      json{{"path", CKPATH}, {"mode", "100644"}, {"type", "blob"}, {"sha", netSha}},
      json{{"path", INFOPATH}, {"mode", "100644"}, {"type", "blob"}, {"sha", infoSha}},
    });
    auto tr = http_->post(api("/git/trees"), tree.dump(), jsonHeaders());
    if (tr.status >= 400) return false;
    std::string treeSha = json::parse(tr.body).at("sha").get<std::string>();

    json commit;
    commit["message"] = "net @ iter " + std::to_string(iter) + " (" + std::to_string(games) + " games)";
    commit["tree"] = treeSha;
    commit["parents"] = json::array();   // orphan
    auto cr = http_->post(api("/git/commits"), commit.dump(), jsonHeaders());
    if (cr.status >= 400) return false;
    std::string commitSha = json::parse(cr.body).at("sha").get<std::string>();

    auto ref = http_->get(api("/git/ref/heads/" + std::string(BRANCH)), jsonHeaders());
    if (ref.status == 200) {
      json patch; patch["sha"] = commitSha; patch["force"] = true;
      auto pr = http_->request("PATCH", api("/git/refs/heads/" + std::string(BRANCH)), patch.dump(), jsonHeaders());
      return pr.status < 400;
    } else {
      json create; create["ref"] = "refs/heads/" + std::string(BRANCH); create["sha"] = commitSha;
      auto cr2 = http_->post(api("/git/refs"), create.dump(), jsonHeaders());
      return cr2.status < 400;
    }
  }

private:
  HttpClient* http_;
  std::string repo_, token_;

  std::string api(const std::string& path) const { return "https://api.github.com/repos/" + repo_ + path; }
  std::string contents(const std::string& path) const {
    return api("/contents/" + path + "?ref=" + std::string(BRANCH));
  }
  std::string blob(const std::string& content) {
    json b; b["content"] = base64(content); b["encoding"] = "base64";
    auto r = http_->post(api("/git/blobs"), b.dump(), jsonHeaders());
    if (r.status >= 400) return "";
    return json::parse(r.body).at("sha").get<std::string>();
  }
  std::vector<Header> rawHeaders() const {
    std::vector<Header> h = {{"Accept", "application/vnd.github.raw"}, {"X-GitHub-Api-Version", "2022-11-28"}};
    if (!token_.empty()) h.push_back({"Authorization", "Bearer " + token_});
    return h;
  }
  std::vector<Header> jsonHeaders() const {
    std::vector<Header> h = {{"Accept", "application/vnd.github+json"}, {"Content-Type", "application/json"},
                             {"X-GitHub-Api-Version", "2022-11-28"}};
    if (!token_.empty()) h.push_back({"Authorization", "Bearer " + token_});
    return h;
  }
};

} // namespace cz
