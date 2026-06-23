/* Cribbage Zero — data-bus Cloudflare Worker (shards-only).
 *
 * The auth + CORS boundary in front of a D1 (SQLite) shard queue. The NET itself is NOT stored here —
 * it lives on the GitHub `net` branch (the learner pushes it; actors pull it). This bus only carries the
 * self-play SAMPLE shards from many actors to the single learner. Two bearer tokens:
 *   WORKER_TOKEN   — actors (phones/PCs): may POST /shard and GET /stats. Append-only.
 *   TRAINER_TOKEN  — the single learner: may also GET /shards and POST /prune (read + drain the queue).
 * A leaked worker token can therefore only contribute self-play — it cannot read or wipe the queue.
 *
 * Routes:
 *   POST /shard  {workerId,samples} -> { ok }                   (actor)    append one self-play shard
 *   GET  /shards?limit=N            -> { shards:[{id,samples}] } (learner)  pull a batch (no delete)
 *   POST /prune  {ids:[...]}        -> { ok, pruned }            (learner)  delete consumed shards
 *   GET  /stats                     -> { pendingShards }         (actor)    queue depth
 *   POST /lease/acquire {id,ttl}    -> { ok, holder, expires_at } (learner) acquire/renew the learner lock
 *   POST /lease/release {id}        -> { ok }                    (learner)  release the lock (clean stop)
 *   GET  /lease                     -> { holder, expires_at }    (learner)  inspect the lock
 *
 * The lease is a single-holder mutual-exclusion lock (TRAINER token) so only ONE learner trains + force-pushes
 * the net at a time; a TTL lets a failover take over if the holder dies. Shards are chunked small by the
 * clients (D1 caps a row's size), so each row stays well within limits.
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
    const isActor = !!tok && (tok === env.WORKER_TOKEN || tok === env.TRAINER_TOKEN);
    const isTrainer = !!tok && tok === env.TRAINER_TOKEN;

    try {
      if (request.method === "POST" && path === "/shard") {
        if (!isActor) return json({ error: "unauthorized" }, 401);
        const body = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.samples) || body.samples.length === 0) return json({ error: "bad request" }, 400);
        await env.DB.prepare("INSERT INTO shards (worker_id, created_at, samples) VALUES (?,?,?)")
          .bind(String(body.workerId || "anon").slice(0, 64), Date.now(), JSON.stringify(body.samples)).run();
        return json({ ok: true });
      }

      if (request.method === "GET" && path === "/shards") {
        if (!isTrainer) return json({ error: "forbidden" }, 403);
        const limit = Math.max(1, Math.min(1000, parseInt(url.searchParams.get("limit") || "200", 10)));
        const rs = await env.DB.prepare("SELECT id, samples FROM shards ORDER BY id LIMIT ?").bind(limit).all();
        return json({ shards: (rs.results || []).map((r) => ({ id: r.id, samples: JSON.parse(r.samples) })) });
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
        if (!isActor) return json({ error: "unauthorized" }, 401);
        const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM shards").first();
        return json({ pendingShards: c ? c.n : 0 });
      }

      // ----- learner lease (single-holder lock; TRAINER token only) — so only ONE learner trains + pushes -----
      if (request.method === "POST" && path === "/lease/acquire") {
        if (!isTrainer) return json({ error: "forbidden" }, 403);
        const body = await request.json().catch(() => null);
        const id = String((body && body.id) || "").slice(0, 64);
        if (!id) return json({ error: "bad request" }, 400);
        const ttl = Math.max(1000, Math.min(3600000, parseInt(body && body.ttl, 10) || 600000));
        const now = Date.now();
        // grant iff the lease is free, already ours, or expired — a single atomic UPDATE (D1 serializes writes)
        await env.DB.prepare("INSERT OR IGNORE INTO lease (id, holder, expires_at) VALUES (1, '', 0)").run();
        await env.DB.prepare("UPDATE lease SET holder=?, expires_at=? WHERE id=1 AND (holder='' OR holder=? OR expires_at < ?)")
          .bind(id, now + ttl, id, now).run();
        const row = await env.DB.prepare("SELECT holder, expires_at FROM lease WHERE id=1").first();
        return json({ ok: !!row && row.holder === id, holder: row ? row.holder : "", expires_at: row ? row.expires_at : 0, now });
      }
      if (request.method === "POST" && path === "/lease/release") {
        if (!isTrainer) return json({ error: "forbidden" }, 403);
        const body = await request.json().catch(() => null);
        const id = String((body && body.id) || "").slice(0, 64);
        await env.DB.prepare("UPDATE lease SET holder='', expires_at=0 WHERE id=1 AND holder=?").bind(id).run();
        return json({ ok: true });
      }
      if (request.method === "GET" && path === "/lease") {
        if (!isTrainer) return json({ error: "forbidden" }, 403);
        const row = await env.DB.prepare("SELECT holder, expires_at FROM lease WHERE id=1").first();
        return json({ holder: row ? row.holder : "", expires_at: row ? row.expires_at : 0, now: Date.now() });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};
