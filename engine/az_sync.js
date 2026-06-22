/* engine/az_sync.js — client for the Cribbage Zero data-bus Worker API.
 *
 * Plain `fetch`, so the SAME source works in Node 18+ (global fetch) and in the browser / Web Worker
 * (where it's concatenated into the bundle). `makeSync({apiUrl, token, workerId})` returns the methods
 * the worker and trainer call; transient failures (5xx / 429 / network) are retried with backoff, 4xx
 * are surfaced. The `module.exports` line is stripped by the browser bundler.
 */
function makeSync(cfg) {
  const base = String(cfg.apiUrl || "").replace(/\/+$/, "");
  const headers = { Authorization: "Bearer " + cfg.token, "Content-Type": "application/json" };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function req(method, path, body) {
    const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok) { const e = new Error(`az_sync ${method} ${path} -> ${res.status}${data && data.error ? " " + data.error : ""}`); e.status = res.status; throw e; }
    return data;
  }
  async function withRetry(fn, tries = 5) {
    let delay = 500;
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (e) {
        const st = e.status || 0;
        if (i >= tries || (st >= 400 && st < 500 && st !== 429)) throw e;   // don't retry 4xx (except 429)
        await sleep(delay + Math.random() * 250); delay = Math.min(delay * 2, 15000);
      }
    }
  }
  return {
    putShard: (samples, workerId) => withRetry(() => req("POST", "/shard", { workerId: workerId || cfg.workerId, samples })),
    getShards: (limit) => withRetry(() => req("GET", "/shards?limit=" + (limit || 200))),
    prune: (ids) => withRetry(() => req("POST", "/prune", { ids })),
    stats: () => withRetry(() => req("GET", "/stats")),
  };
}
if (typeof module !== "undefined" && module.exports) module.exports = { makeSync };
