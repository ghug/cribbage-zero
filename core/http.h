// http.h — HTTP client interface (curl-free). Orchestration depends only on this; implementations are a
// libcurl adapter (http_curl.h) for PC and, later, a JNI bridge for Android — plus a mock for tests.
#pragma once
#include <string>
#include <vector>

namespace cz {

struct Header { std::string key, value; };
struct HttpResponse { long status = 0; std::string body; }; // status -1 = transport error (body = message)

class HttpClient {
public:
  virtual ~HttpClient() = default;
  virtual HttpResponse request(const std::string& method, const std::string& url,
                               const std::string& body, const std::vector<Header>& headers) = 0;
  HttpResponse get(const std::string& url, const std::vector<Header>& headers = {}) {
    return request("GET", url, "", headers);
  }
  HttpResponse post(const std::string& url, const std::string& body, const std::vector<Header>& headers = {}) {
    return request("POST", url, body, headers);
  }
};

} // namespace cz
