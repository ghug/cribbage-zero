/* Cribbage Zero — data-bus Cloudflare Worker.
 *
 * The auth + CORS boundary in front of a D1 (SQLite) shard-queue + checkpoint. Two bearer tokens:
 *   WORKER_TOKEN  — devices/PCs: may POST /shard and GET /checkpoint (+ /stats). Append + read only.
 *   TRAINER_TOKEN — the single trainer: may also GET /shards, POST /checkpoint, POST /prune.
 * A leaked worker token therefore can only contribute self-play and read the net — it cannot consume,
 * overwrite the checkpoint, or wipe the store.
 *
 * Routes:
 *   GET  /checkpoint            -> { iter, net }              (worker)   latest net (net=null if none)
 *   POST /shard  {workerId,samples} -> { ok }                 (worker)   append a self-play shard
 *   GET  /shards?limit=N        -> { shards:[{id,samples}] }  (trainer)  pull a batch (no delete)
 *   POST /checkpoint {iter,net} -> { ok, iter }               (trainer)  publish the net (upsert)
 *   POST /prune  {ids:[...]}    -> { ok, pruned }             (trainer)  delete consumed shards
 *   GET  /stats                 -> { pendingShards, iter }    (worker)
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
  "Access-Control-Max-Age": "86400",
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });
const bearer = (req) => { const h = req.headers.get("Authorization") || ""; return h.startsWith("Bearer ") ? h.slice(7) : ""; };

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const tok = bearer(request);
    const isWorker = !!tok && (tok === env.WORKER_TOKEN || tok === env.TRAINER_TOKEN);
    const isTrainer = !!tok && tok === env.TRAINER_TOKEN;

    try {
      if (request.method === "GET" && path === "/checkpoint") {
        if (!isWorker) return json({ error: "unauthorized" }, 401);
        const row = await env.DB.prepare("SELECT iter, net FROM checkpoint WHERE id=1").first();
        return json(row ? { iter: row.iter, net: JSON.parse(row.net) } : { iter: 0, net: null });
      }

      if (request.method === "POST" && path === "/shard") {
        if (!isWorker) return json({ error: "unauthorized" }, 401);
        const body = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.samples) || body.samples.length === 0) return json({ error: "bad request" }, 400);
        await env.DB.prepare("INSERT INTO shards (worker_id, created_at, samples) VALUES (?,?,?)")
          .bind(String(body.workerId || "anon").slice(0, 64), Date.now(), JSON.stringify(body.samples)).run();
        // Piggyback the current trainer iter (one indexed single-row read) so workers never need to poll
        // /checkpoint or /stats — they fetch the net only when this iter actually advances.
        const ck = await env.DB.prepare("SELECT iter FROM checkpoint WHERE id=1").first();
        return json({ ok: true, iter: ck ? ck.iter : 0 });
      }

      if (request.method === "GET" && path === "/shards") {
        if (!isTrainer) return json({ error: "forbidden" }, 403);
        const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get("limit") || "100", 10)));
        const rs = await env.DB.prepare("SELECT id, samples FROM shards ORDER BY id LIMIT ?").bind(limit).all();
        return json({ shards: (rs.results || []).map((r) => ({ id: r.id, samples: JSON.parse(r.samples) })) });
      }

      if (request.method === "POST" && path === "/checkpoint") {
        if (!isTrainer) return json({ error: "forbidden" }, 403);
        // body is the flat net object: { iter, nIn, nHid, nPol, W1, b1, Wv, bv, Wp, bp }
        const body = await request.json().catch(() => null);
        if (!body || typeof body.iter !== "number" || !Array.isArray(body.W1)) return json({ error: "bad request" }, 400);
        await env.DB.prepare(
          "INSERT INTO checkpoint (id,iter,net,updated_at) VALUES (1,?,?,?) " +
          "ON CONFLICT(id) DO UPDATE SET iter=excluded.iter, net=excluded.net, updated_at=excluded.updated_at")
          .bind(body.iter, JSON.stringify(body), Date.now()).run();
        return json({ ok: true, iter: body.iter });
      }

      if (request.method === "POST" && path === "/prune") {
        if (!isTrainer) return json({ error: "forbidden" }, 403);
        const body = await request.json().catch(() => null);
        const ids = (body && Array.isArray(body.ids) ? body.ids : []).filter((x) => Number.isInteger(x));
        if (ids.length) {
          const ph = ids.map(() => "?").join(",");
          await env.DB.prepare(`DELETE FROM shards WHERE id IN (${ph})`).bind(...ids).run();
        }
        return json({ ok: true, pruned: ids.length });
      }

      if (request.method === "GET" && path === "/stats") {
        if (!isWorker) return json({ error: "unauthorized" }, 401);
        const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM shards").first();
        const ck = await env.DB.prepare("SELECT iter FROM checkpoint WHERE id=1").first();
        return json({ pendingShards: c ? c.n : 0, iter: ck ? ck.iter : 0 });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};
