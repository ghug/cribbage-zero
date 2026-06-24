/* Node test for the shards-only data-bus Worker: exercises every route + the auth boundary against an
 * in-memory mock D1 (no wrangler / Cloudflare needed). Node 18+ global Request/Response/URL. Run: node test.js */
import worker from "./src/index.js";

// minimal mock of the D1 prepared-statement API for exactly the queries the Worker issues
function mockDB() {
  const st = { shards: [], nextId: 1, lease: { holder: "", expires_at: 0 } };
  return {
    _st: st,
    prepare(sql) {
      let args = [];
      return {
        bind(...a) { args = a; return this; },
        async first() {
          if (sql.includes("COUNT(*)")) return { n: st.shards.length };
          if (sql.includes("FROM lease")) return { holder: st.lease.holder, expires_at: st.lease.expires_at };
          return null;
        },
        async all() {
          if (sql.includes("FROM shards")) { const lim = args[0] || 200; return { results: st.shards.slice(0, lim).map((s) => ({ id: s.id, samples: s.samples })) }; }
          return { results: [] };
        },
        async run() {
          if (sql.startsWith("INSERT INTO shards")) st.shards.push({ id: st.nextId++, worker_id: args[0], created_at: args[1], samples: args[2] });
          else if (sql.startsWith("DELETE FROM shards")) { const ids = new Set(args); st.shards = st.shards.filter((s) => !ids.has(s.id)); }
          else if (sql.startsWith("INSERT OR IGNORE INTO lease")) { /* the single row always exists in the mock */ }
          else if (sql.startsWith("UPDATE lease SET holder=?")) { const [id, exp, owner, now] = args; if (st.lease.holder === "" || st.lease.holder === owner || st.lease.expires_at < now) { st.lease.holder = id; st.lease.expires_at = exp; } }
          else if (sql.startsWith("UPDATE lease SET holder=''")) { const [id] = args; if (st.lease.holder === id) { st.lease.holder = ""; st.lease.expires_at = 0; } }
          return { success: true };
        },
      };
    },
  };
}

const W = "worker-tok", T = "trainer-tok";
const env = { DB: mockDB(), WORKER_TOKEN: W, TRAINER_TOKEN: T };
const call = (method, path, token, body) => worker.fetch(new Request("https://bus.example" + path, {
  method, headers: { ...(token ? { Authorization: "Bearer " + token } : {}), "Content-Type": "application/json" },
  body: body !== undefined ? JSON.stringify(body) : undefined,
}), env);

let ok = 0, fail = 0;
const check = (c, m) => { if (c) ok++; else { fail++; console.error("  ✗ " + m); } };
async function js(r) { return { status: r.status, body: await r.json().catch(() => ({})) }; }

(async () => {
  // CORS preflight
  { const r = await call("OPTIONS", "/shard"); check(r.status === 204 && r.headers.get("Access-Control-Allow-Origin") === "*", "OPTIONS preflight returns 204 + CORS"); }

  // auth boundary
  check((await js(await call("POST", "/shard", null, { samples: [{ z: 1 }] }))).status === 401, "no token -> 401 on /shard");
  check((await js(await call("POST", "/shard", "bogus", { samples: [{ z: 1 }] }))).status === 401, "bad token -> 401");
  check((await js(await call("GET", "/shards", W))).status === 403, "WORKER token -> 403 on /shards (trainer-only)");
  check((await js(await call("POST", "/prune", W, { ids: [1] }))).status === 403, "WORKER token -> 403 on /prune");

  // actor appends shards
  check((await js(await call("POST", "/shard", W, { workerId: "w1", samples: [{ x: [1], pi: [1], legal: [true], z: 1 }] }))).body.ok === true, "actor POST /shard ok");
  await call("POST", "/shard", W, { workerId: "w2", samples: [{ z: -1 }] });
  check((await js(await call("POST", "/shard", W, { workerId: "w1", samples: [] }))).status === 400, "empty samples -> 400");

  // stats
  { const r = await js(await call("GET", "/stats", W)); check(r.body.pendingShards === 2, "stats reports 2 pending shards"); }

  // learner pulls + prunes
  { const r = await js(await call("GET", "/shards", T)); check(r.body.shards.length === 2 && r.body.shards[0].samples[0].z === 1, "learner GET /shards returns both with parsed samples"); }
  { const ids = (await js(await call("GET", "/shards", T))).body.shards.map((s) => s.id);
    check((await js(await call("POST", "/prune", T, { ids }))).body.pruned === 2, "learner prunes consumed shards"); }
  check((await js(await call("GET", "/stats", W))).body.pendingShards === 0, "shard queue empty after prune");

  // learner lease (single-writer lock; trainer-only)
  check((await js(await call("POST", "/lease/acquire", W, { id: "a" }))).status === 403, "WORKER token -> 403 on /lease/acquire");
  check((await js(await call("POST", "/lease/acquire", T, { id: "learnerA", ttl: 60000 }))).body.ok === true, "learnerA acquires the lease");
  { const r = await js(await call("POST", "/lease/acquire", T, { id: "learnerB", ttl: 60000 }));
    check(r.body.ok === false && r.body.holder === "learnerA", "learnerB denied while A holds it"); }
  check((await js(await call("POST", "/lease/acquire", T, { id: "learnerA", ttl: 60000 }))).body.ok === true, "learnerA renews its own lease");
  check((await js(await call("POST", "/lease/release", T, { id: "learnerA" }))).body.ok === true, "learnerA releases the lease");
  check((await js(await call("POST", "/lease/acquire", T, { id: "learnerB", ttl: 60000 }))).body.ok === true, "learnerB acquires after release");
  check((await js(await call("GET", "/lease", T))).body.holder === "learnerB", "GET /lease shows the holder (trainer token)");
  check((await js(await call("GET", "/lease", W))).body.holder === "learnerB", "GET /lease shows the holder (WORKER token — read-only status)");
  env.DB._st.lease.expires_at = 1;   // force-expire learnerB's lease
  check((await js(await call("POST", "/lease/acquire", T, { id: "learnerC", ttl: 60000 }))).body.ok === true, "an expired lease can be taken over");

  // checkpoint routes are gone (net is on GitHub)
  check((await js(await call("GET", "/checkpoint", T))).status === 404, "/checkpoint removed -> 404");
  check((await js(await call("GET", "/nope", W))).status === 404, "unknown route -> 404");

  console.log(`\nworker-api test: ${ok} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
