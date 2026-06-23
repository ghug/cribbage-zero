// net_io.h — JSON (de)serialization of the net, info, and samples (nlohmann/json). The net stores weights
// FLAT per layer (W[l] = row-major dout*din) — fresh-start format we own; din/dout are recomputed from
// nIn+hidden on load, so they aren't stored. The net branch holds this JSON; samples are the bus payload.
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
  o["W"] = net.W; o["b"] = net.b;            // W[l]/b[l] are flat per-layer vectors
  o["Wv"] = net.Wv; o["bv"] = net.bv; o["Wp"] = net.Wp; o["bp"] = net.bp;
  return o;
}

inline Net netFromJson(const json& o) {
  std::vector<int> hidden = o.at("hidden").get<std::vector<int>>();
  Net net(o.at("nIn").get<int>(), hidden, o.at("nPol").get<int>());   // sets din_/dout_/nHid + random weights
  net.W = o.at("W").get<std::vector<std::vector<float>>>();
  net.b = o.at("b").get<std::vector<std::vector<float>>>();
  net.Wv = o.at("Wv").get<std::vector<float>>();
  net.bv = o.at("bv").get<float>();
  net.Wp = o.at("Wp").get<std::vector<float>>();
  net.bp = o.at("bp").get<std::vector<float>>();
  return net;
}

inline bool validNetJson(const json& o, int nIn, const std::vector<int>& hidden, int nPol) {
  if (!o.is_object() || !o.contains("nIn") || !o.contains("hidden") || !o.contains("W")) return false;
  if (o["nIn"].get<int>() != nIn || o.value("nPol", -1) != nPol) return false;
  return o["hidden"].get<std::vector<int>>() == hidden;
}

// samples for the bus — rounded to 3 dp (inputs are mostly 0/1) to keep payloads small.
inline json sampleToJson(const Sample& s) {
  auto r3 = [](float x) { return std::round(x * 1000.0f) / 1000.0f; };
  json jx = json::array(), jpi = json::array(), jlg = json::array();
  for (float v : s.x) jx.push_back(r3(v));
  for (float v : s.pi) jpi.push_back(r3(v));
  for (bool v : s.legal) jlg.push_back(v ? 1 : 0);
  return json{{"x", jx}, {"pi", jpi}, {"legal", jlg}, {"z", s.z}};
}

inline Sample sampleFromJson(const json& o) {
  Sample s;
  s.x = o.at("x").get<std::vector<float>>();
  s.pi = o.at("pi").get<std::vector<float>>();
  for (const auto& v : o.at("legal")) s.legal.push_back(v.get<int>() != 0);
  s.z = o.at("z").get<double>();
  return s;
}

} // namespace cz
