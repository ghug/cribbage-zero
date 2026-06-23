// test_http.cpp — REAL HTTP smoke (needs network; run manually, not a ctest). GETs the public net info.json
// from GitHub via libcurl to prove the HttpClient + TLS + egress all work.
#include "../http_curl.h"
#include "../net_io.h"
#include <cstdio>

using namespace cz;

int main() {
  HttpCurl http;
  std::string url = "https://api.github.com/repos/ghug/cribbage-zero/contents/checkpoints/info.json?ref=net";
  std::vector<Header> h = {{"Accept", "application/vnd.github.raw"}, {"X-GitHub-Api-Version", "2022-11-28"}};
  const char* tok = std::getenv("CZ_TOKEN"); if (!tok) tok = std::getenv("GIT_PAT");
  if (tok && *tok) h.push_back({"Authorization", std::string("Bearer ") + tok});   // dodge the anon rate limit
  auto r = http.get(url, h);
  std::printf("GET info.json -> status %ld\n", r.status);
  std::printf("body: %.200s\n", r.body.c_str());
  if (r.status == 200) {
    try {
      auto j = json::parse(r.body);
      std::printf("parsed: games=%ld iter=%d\n", (long)j.value("games", 0L), j.value("iter", 0));
      std::printf("HTTP smoke OK\n");
      return 0;
    } catch (const std::exception& e) { std::printf("parse error: %s\n", e.what()); return 2; }
  }
  std::printf("HTTP smoke: non-200 (network/egress?)\n");
  return 1;
}
