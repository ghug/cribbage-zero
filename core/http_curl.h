// http_curl.h — libcurl-backed HttpClient (PC). The ONLY file that needs libcurl; it's a thin adapter with
// no orchestration logic. Android will provide a different HttpClient (JNI → HttpURLConnection).
#pragma once
#include "http.h"
#include <curl/curl.h>

namespace cz {

class HttpCurl : public HttpClient {
public:
  HttpCurl() { curl_global_init(CURL_GLOBAL_DEFAULT); }
  ~HttpCurl() override { curl_global_cleanup(); }

  HttpResponse request(const std::string& method, const std::string& url,
                       const std::string& body, const std::vector<Header>& headers) override {
    HttpResponse r;
    CURL* c = curl_easy_init();
    if (!c) { r.status = -1; r.body = "curl init failed"; return r; }
    std::string resp;
    curl_easy_setopt(c, CURLOPT_URL, url.c_str());
    if (method == "GET") {
      curl_easy_setopt(c, CURLOPT_HTTPGET, 1L);
    } else {
      curl_easy_setopt(c, CURLOPT_CUSTOMREQUEST, method.c_str());
      curl_easy_setopt(c, CURLOPT_POSTFIELDS, body.c_str());
      curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, (long)body.size());
    }
    struct curl_slist* hl = nullptr;
    for (const auto& h : headers) hl = curl_slist_append(hl, (h.key + ": " + h.value).c_str());
    if (hl) curl_easy_setopt(c, CURLOPT_HTTPHEADER, hl);
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, &writeCb);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &resp);
    curl_easy_setopt(c, CURLOPT_USERAGENT, "cribbage-zero-cpp");
    curl_easy_setopt(c, CURLOPT_TIMEOUT, 120L);
    curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(c, CURLOPT_ACCEPT_ENCODING, ""); // allow gzip (GitHub raw can be large)
    CURLcode rc = curl_easy_perform(c);
    if (rc != CURLE_OK) { r.status = -1; r.body = curl_easy_strerror(rc); }
    else { long code = 0; curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &code); r.status = code; r.body = std::move(resp); }
    if (hl) curl_slist_free_all(hl);
    curl_easy_cleanup(c);
    return r;
  }

private:
  static size_t writeCb(char* ptr, size_t sz, size_t n, void* ud) {
    ((std::string*)ud)->append(ptr, sz * n);
    return sz * n;
  }
};

} // namespace cz
