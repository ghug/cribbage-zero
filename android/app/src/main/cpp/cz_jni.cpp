// cz_jni.cpp — JNI entry points for the Android native actor.
//
// Step 1 (this file, for now): a self-play SMOKE that exercises the whole header-only engine (net + game +
// MCTS + self-play + the std::thread pool) so CI proves the C++ core compiles, links, and packages under the
// Android NDK. Later steps add the JNI->Java HttpURLConnection bridge and the bus/GitHub actor loop here.
#include <jni.h>
#include <android/log.h>
#include <vector>
#include <chrono>
#include <cstdio>
#include <cstdint>
#include "parallel.h"   // selfplay + net + game + mcts + the thread pool (curl-free)

using namespace cz;
#define CZLOG(...) __android_log_print(ANDROID_LOG_INFO, "cz", __VA_ARGS__)

extern "C" JNIEXPORT jstring JNICALL
Java_dev_cribbage_zero_NativeBridge_selfPlayBench(JNIEnv* env, jclass, jint pairs, jint sims, jint workers) {
  const std::vector<int> HIDDEN = {256, 256, 256, 256};
  Net net(INPUT_DIM, HIDDEN, NPOL, 0.0, 1);   // fresh random net (no I/O)
  std::vector<Sample> s;
  int w = workers > 0 ? (int)workers : 2;
  int p = pairs > 0 ? (int)pairs : 4;
  auto t0 = std::chrono::steady_clock::now();
  long g = parallelSelfPlay(net, sims > 0 ? (int)sims : 40, 1.5, p, w, 12345u, s,
                            /*tempMoves=*/30, /*dirEps=*/0.25, /*dirAlpha=*/0.8, /*fpu=*/0.25, /*cBase=*/19652.0);
  double dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  char buf[192];
  std::snprintf(buf, sizeof buf, "NDK self-play OK: %ld games, %zu samples, %.2fs = %.2f g/s (workers %d)",
                g, s.size(), dt, dt > 0 ? g / dt : 0.0, w);
  CZLOG("%s", buf);
  return env->NewStringUTF(buf);
}
