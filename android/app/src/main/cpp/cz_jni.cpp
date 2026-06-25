// cz_jni.cpp — JNI entry points for the Android native actor.
//
//   selfPlayBench(pairs,sims,workers)  -> a self-play smoke that exercises the whole engine (proves the NDK build).
//   runActor(repo,busUrl,busTok,token,sims,workers,pairsPerRound,shardMax)
//                                      -> BLOCKS, running the shared actor loop (core/actor.h): pull net ->
//                                         self-play -> upload shards -> refresh net, until stopActor() is called.
//   stopActor()                        -> signal the loop to stop (called from another thread).
//
// HTTP is bridged to Java: the actor loop calls NativeBridge.httpRequest(method,url,body,headers) (which uses
// HttpURLConnection) — so no libcurl in the NDK. runActor() runs on the Java thread that invoked it, so its
// JNIEnv is valid for the httpRequest callbacks; the self-play worker threads are pure native (no JNI).
#include <jni.h>
#include <android/log.h>
#include <vector>
#include <string>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdint>
#include <ctime>
#include "parallel.h"   // self-play + the engine (curl-free)
#include "actor.h"      // the shared actor loop (runActorLoop)
#include "eval.h"       // native net eval (evalVsRandom / evalVsHard)
#include "github.h"     // GithubNet (pull the net for eval)
#include "net_io.h"     // netFromJson / validNetJson

using namespace cz;
#define CZLOG(...) __android_log_print(ANDROID_LOG_INFO, "cz", __VA_ARGS__)

static std::atomic<bool> g_stop{false};

// HttpClient that bridges each request to Java NativeBridge.httpRequest(...) -> "status\nbody".
class JniHttp : public HttpClient {
public:
  JniHttp(JNIEnv* env, jclass cls, jmethodID mid) : env_(env), cls_(cls), mid_(mid) {}
  HttpResponse request(const std::string& method, const std::string& url,
                       const std::string& body, const std::vector<Header>& headers) override {
    std::string hdr;
    for (const auto& h : headers) { hdr += h.key; hdr += ": "; hdr += h.value; hdr += "\n"; }
    jstring jm = env_->NewStringUTF(method.c_str());
    jstring ju = env_->NewStringUTF(url.c_str());
    jstring jb = env_->NewStringUTF(body.c_str());
    jstring jh = env_->NewStringUTF(hdr.c_str());
    jobject res = env_->CallStaticObjectMethod(cls_, mid_, jm, ju, jb, jh);
    env_->DeleteLocalRef(jm); env_->DeleteLocalRef(ju); env_->DeleteLocalRef(jb); env_->DeleteLocalRef(jh);
    HttpResponse r;
    if (env_->ExceptionCheck()) { env_->ExceptionClear(); r.status = -1; r.body = "jni exception"; return r; }
    if (!res) { r.status = -1; r.body = "null http response"; return r; }
    const char* c = env_->GetStringUTFChars(static_cast<jstring>(res), nullptr);
    std::string s(c ? c : "");
    env_->ReleaseStringUTFChars(static_cast<jstring>(res), c);
    env_->DeleteLocalRef(res);
    auto nl = s.find('\n');
    if (nl == std::string::npos) { r.status = std::atol(s.c_str()); }
    else { r.status = std::atol(s.substr(0, nl).c_str()); r.body = s.substr(nl + 1); }
    return r;
  }
private:
  JNIEnv* env_;
  jclass cls_;
  jmethodID mid_;
};

static std::string jstr(JNIEnv* env, jstring s) {
  if (!s) return std::string();
  const char* c = env->GetStringUTFChars(s, nullptr);
  std::string r(c ? c : "");
  env->ReleaseStringUTFChars(s, c);
  return r;
}

extern "C" JNIEXPORT jstring JNICALL
Java_dev_cribbage_zero_NativeBridge_selfPlayBench(JNIEnv* env, jclass, jint pairs, jint sims, jint workers) {
  const std::vector<int> HIDDEN = {256, 256, 256, 256};
  Net net(INPUT_DIM, HIDDEN, NPOL, 0.0, 1);
  std::vector<Sample> s;
  int w = workers > 0 ? (int)workers : 2;
  int p = pairs > 0 ? (int)pairs : 4;
  auto t0 = std::chrono::steady_clock::now();
  long g = parallelSelfPlay(net, sims > 0 ? (int)sims : 40, 1.5, p, w, 12345u, s,
                            30, 0.25, 0.8, 0.25, 19652.0);
  double dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  char buf[192];
  std::snprintf(buf, sizeof buf, "NDK self-play OK: %ld games, %zu samples, %.2fs = %.2f g/s (workers %d)",
                g, s.size(), dt, dt > 0 ? g / dt : 0.0, w);
  CZLOG("%s", buf);
  return env->NewStringUTF(buf);
}

extern "C" JNIEXPORT jstring JNICALL
Java_dev_cribbage_zero_NativeBridge_runActor(JNIEnv* env, jclass cls,
    jstring jrepo, jstring jbusUrl, jstring jbusTok, jstring jtoken,
    jint sims, jint workers, jint pairsPerRound, jint shardMax, jint refreshMin) {
  jmethodID mid = env->GetStaticMethodID(cls, "httpRequest",
      "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;");
  if (!mid) return env->NewStringUTF("error: NativeBridge.httpRequest not found");
  jmethodID logMid = env->GetStaticMethodID(cls, "onActorLog", "(Ljava/lang/String;)V");
  jmethodID alertMid = env->GetStaticMethodID(cls, "onActorAlert", "(Ljava/lang/String;)V");

  ActorConfig cfg;
  std::string repo = jstr(env, jrepo);
  if (!repo.empty()) cfg.repo = repo;
  cfg.busUrl = jstr(env, jbusUrl);
  cfg.busToken = jstr(env, jbusTok);
  cfg.token = jstr(env, jtoken);
  cfg.sims = (int)sims; cfg.workers = (int)workers;
  cfg.pairsPerRound = (int)pairsPerRound; cfg.shardMax = (int)shardMax;
  cfg.refreshMinSec = refreshMin > 0 ? (int)refreshMin * 60 : 0;   // UI passes minutes; 0 = no throttle
  cfg.seed = (uint32_t)time(nullptr);
  cfg.workerId = "android-" + std::to_string((long)time(nullptr));

  JniHttp http(env, cls, mid);
  g_stop = false;
  // log callback runs on this (the calling Java) thread, so it can hand each line back to Java for the
  // actor page's live readout, in addition to logcat.
  auto logFn = [env, cls, logMid](const std::string& m) {
    CZLOG("%s", m.c_str());
    if (logMid) { jstring jm = env->NewStringUTF(m.c_str()); env->CallStaticVoidMethod(cls, logMid, jm); env->DeleteLocalRef(jm); }
  };
  // escalated bus-failure alert (rising edge only — see runActorLoop). Java decides whether to surface it as a
  // heads-up notification, per the actor page's "alert me if uploads fail" toggle.
  auto alertFn = [env, cls, alertMid](const std::string& m) {
    if (alertMid) { jstring jm = env->NewStringUTF(m.c_str()); env->CallStaticVoidMethod(cls, alertMid, jm); env->DeleteLocalRef(jm); }
  };
  long total = runActorLoop(http, cfg, g_stop, logFn, alertFn);
  char buf[96];
  std::snprintf(buf, sizeof buf, "actor finished: %ld games", total);
  CZLOG("%s", buf);
  return env->NewStringUTF(buf);
}

extern "C" JNIEXPORT void JNICALL
Java_dev_cribbage_zero_NativeBridge_stopActor(JNIEnv*, jclass) { g_stop = true; }

// runEval(repo, token, which, decks) -> "<winPct>" (1 decimal) or "error: ...". which: 0 = vs random, 1 = vs
// hard. BLOCKS — call on a background thread. Pulls the net via the Java HTTP bridge, then runs the antithetic
// match natively (greedy net; same basis as engine/eval_zero.js). Reports progress via onEvalProgress(double).
// branch/path select the net to score: empty path = the live net (checkpoints/az_checkpoint.json on the net
// branch); a non-empty path pulls that file from `branch` (e.g. net-archive snapshots/<name>.json) so a
// snapshot can be evaluated without first rolling it back onto the live net.
extern "C" JNIEXPORT jstring JNICALL
Java_dev_cribbage_zero_NativeBridge_runEval(JNIEnv* env, jclass cls, jstring jrepo, jstring jtoken, jint which, jint decks,
                                            jstring jbranch, jstring jpath) {
  jmethodID mid = env->GetStaticMethodID(cls, "httpRequest",
      "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;");
  if (!mid) return env->NewStringUTF("error: NativeBridge.httpRequest not found");
  jmethodID progMid = env->GetStaticMethodID(cls, "onEvalProgress", "(D)V");

  std::string repo = jstr(env, jrepo), token = jstr(env, jtoken);
  std::string branch = jstr(env, jbranch), path = jstr(env, jpath);
  if (repo.empty()) repo = "ghug/cribbage-zero";
  const std::vector<int> HIDDEN = {256, 256, 256, 256};
  JniHttp http(env, cls, mid);
  GithubNet gh(&http, repo, token, "net");
  Net net(INPUT_DIM, HIDDEN, NPOL, 0.0, 1);
  try {
    auto n = path.empty() ? gh.pullNet() : gh.pullFrom(branch.empty() ? "net-archive" : branch, path);
    if (!n) return env->NewStringUTF(path.empty() ? "error: no net on GitHub yet" : "error: snapshot not found");
    if (!validNetJson(*n, INPUT_DIM, HIDDEN, NPOL)) return env->NewStringUTF("error: net architecture mismatch");
    net = netFromJson(*n);
  } catch (const std::exception& e) { return env->NewStringUTF((std::string("error: ") + e.what()).c_str()); }

  auto prog = [env, cls, progMid](double f) { if (progMid) env->CallStaticVoidMethod(cls, progMid, (jdouble)f); };
  int pairs = decks > 0 ? (int)decks : 5000;
  Rng rng((uint32_t)(time(nullptr) ^ 0x5eed));
  double frac = (which == 1) ? evalVsHard(net, pairs, rng, prog) : evalVsRandom(net, pairs, rng, prog);
  char buf[32]; std::snprintf(buf, sizeof buf, "%.1f", 100.0 * frac);
  CZLOG("eval which=%d decks=%d -> %s%%", (int)which, (int)decks, buf);
  return env->NewStringUTF(buf);
}
