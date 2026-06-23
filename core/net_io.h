// net_io.h — JSON (de)serialization of the net, the info file, and self-play samples (nlohmann/json).
// The net JSON lives on the GitHub `net` branch; samples are the bus payload. Fresh-start format (we own it).
#pragma once
#include <nlohmann/json.hpp>
#include "net.h"
#include "sample.h"
#include <string>

namespace cz {

using json = nlohmann::json;

inline json netToJson(const Net& net, int iter, long games) {
  json o;
  o["nIn"] = net.nIn; o["hidden"] = net.hidden; o["nPol"] = net.nPol; o["nHid"] = net.nHid;
  o["iter"] = iter; o["games"] = games;
  o["W"] = net.W; o["b"] = net.b;
  o["Wv"] = net.Wv; o["bv"] = net.bv; o["Wp"] = net.Wp; o["bp"] = net.bp;
  return o;
}

inline Net netFromJson(const json& o) {
  std::vector<int> hidden = o.at("hidden").get<std::vector<int>>();
  Net net(o.at("nIn").get<int>(), hidden, o.at("nPol").get<int>(), 0.0, 1);
  net.W = o.at("W").get<std::vector<std::vector<std::vector<double>>>>();
  net.b = o.at("b").get<std::vector<std::vector<double>>>();
  net.Wv = o.at("Wv").get<std::vector<double>>();
  net.bv = o.at("bv").get<double>();
  net.Wp = o.at("Wp").get<std::vector<std::vector<double>>>();
  net.bp = o.at("bp").get<std::vector<double>>();
  return net;
}

// matches the JS validity check enough to refuse a wrong-architecture / malformed net
inline bool validNetJson(const json& o, int nIn, const std::vector<int>& hidden, int nPol) {
  if (!o.is_object() || !o.contains("nIn") || !o.contains("hidden") || !o.contains("W")) return false;
  if (o["nIn"].get<int>() != nIn || o.value("nPol", -1) != nPol) return false;
  auto h = o["hidden"].get<std::vector<int>>();
  return h == hidden;
}

// samples for the bus. Rounded to keep the payload small (the JS client did 3 dp); inputs are mostly 0/1.
inline json sampleToJson(const Sample& s) {
  auto round3 = [](double x) { return std::round(x * 1000.0) / 1000.0; };
  json jx = json::array(), jpi = json::array(), jlg = json::array();
  for (double v : s.x) jx.push_back(round3(v));
  for (double v : s.pi) jpi.push_back(round3(v));
  for (bool v : s.legal) jlg.push_back(v ? 1 : 0);
  return json{{"x", jx}, {"pi", jpi}, {"legal", jlg}, {"z", s.z}};
}

inline Sample sampleFromJson(const json& o) {
  Sample s;
  s.x = o.at("x").get<std::vector<double>>();
  s.pi = o.at("pi").get<std::vector<double>>();
  for (const auto& v : o.at("legal")) s.legal.push_back(v.get<int>() != 0);
  s.z = o.at("z").get<double>();
  return s;
}

} // namespace cz
