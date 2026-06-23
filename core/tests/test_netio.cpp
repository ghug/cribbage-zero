// test_netio.cpp — JSON round-trips for the net and samples (no network).
#include "../net_io.h"
#include "../selfplay.h"
#include <cstdio>

using namespace cz;
static int ok = 0, fail = 0;
static void check(bool c, const char* m) { if (c) ok++; else { fail++; std::printf("  x %s\n", m); } }

int main() {
  // 1) net round-trip: a random net → json → parse → identical forward outputs on a probe input.
  {
    Net net(INPUT_DIM, {32, 16}, NPOL, 0.0, /*seed=*/5);
    json o = netToJson(net, 7, 1234);
    check(o["iter"] == 7 && o["games"] == 1234, "net json carries iter/games");
    check(validNetJson(o, INPUT_DIM, {32, 16}, NPOL), "validNetJson accepts a matching net");
    check(!validNetJson(o, INPUT_DIM, {64}, NPOL), "validNetJson rejects a wrong architecture");

    // serialize → string → parse (exercises the real wire path)
    std::string wire = o.dump();
    Net net2 = netFromJson(json::parse(wire));

    Rng rng(42);
    std::vector<float> x(INPUT_DIM);
    for (auto& v : x) v = rng.next() * 2 - 1;
    Forward a = net.forward(x), b = net2.forward(x);
    double dv = std::fabs(a.v - b.v), dl = 0;
    for (int j = 0; j < NPOL; j++) dl = std::max(dl, (double)std::fabs(a.logits[j] - b.logits[j]));
    check(dv < 1e-12 && dl < 1e-12, "net survives json round-trip bit-for-bit (forward identical)");
  }

  // 2) sample round-trip (with the 3dp rounding the wire applies)
  {
    Net net(INPUT_DIM, {16}, NPOL, 0.0, 3);
    Mcts mcts; Rng searchRng(1);
    std::vector<Sample> data;
    playMatchPair(net, 8, 1.5, 4242, searchRng, mcts, data);
    check(!data.empty(), "produced samples to round-trip");

    const Sample& s = data[data.size() / 2];
    json js = sampleToJson(s);
    Sample r = sampleFromJson(json::parse(js.dump()));
    check((int)r.x.size() == INPUT_DIM && (int)r.legal.size() == NPOL, "sample shapes survive");
    check(r.z == s.z, "sample z survives");
    bool legalOk = true; for (int j = 0; j < NPOL; j++) if (r.legal[j] != s.legal[j]) legalOk = false;
    check(legalOk, "sample legal mask survives");
    double dx = 0; for (size_t i = 0; i < s.x.size(); i++) dx = std::max(dx, (double)std::fabs(r.x[i] - s.x[i]));
    check(dx <= 0.001 + 1e-12, "sample x survives within the 3dp wire rounding");
  }

  std::printf("\nnetio test: %d passed, %d failed\n", ok, fail);
  return fail ? 1 : 0;
}
