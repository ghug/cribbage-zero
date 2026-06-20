/* Node test for the data-bus Worker: exercises every route + the auth boundary against an in-memory
 * mock D1 (no wrangler / Cloudflare needed). Uses Node 18+ global Request/Response/URL. Run: node test.js */
import worker from "./src/index.js";

// minimal mock of the D1 prepared-statement API for exactly the queries the Worker issues
function mockDB() {
  const st = { checkpoint: null, shards: [], nextId: 1 };
  const api = {
    _st: st,
    prepare(sql) {
      let args = [];
      return {
        bind(...a) { args = a; return this; },
        async first() {
          if (sql.includes("SELECT iter, net FROM checkpoint")) return st.checkpoint ? { iter: st.checkpoint.iter, net: st.checkpoint.net } : null;
          if (sql.includes("COUNT(*)")) return { n: st.shards.length };
          if (sql.includes("SELECT iter FROM checkpoint")) return st.checkpoint ? { iter: st.checkpoint.iter } : null;
          return null;
        },
        async all() {
          if (sql.includes("FROM shards")) { const lim = args[0] || 100; return { results: st.shards.slice(0, lim).map((s) => ({ id: s.id, samples: s.samples })) }; }
          return { results: [] };
        },
        async run() {
          if (sql.startsWith("INSERT INTO shards")) st.shards.push({ id: st.nextId++, worker_id: args[0], created_at: args[1], samples: args[2] });
          else if (sql.startsWith("INSERT INTO checkpoint")) st.checkpoint = { iter: args[0], net: args[1] };
          else if (sql.startsWith("DELETE FROM shards")) { const ids = new Set(args); st.shards = st.shards.filter((s) => !ids.has(s.id)); }
          return { success: true };
        },
      };
    },
  };
  return api;
}

const W = "worker-tok", T = "trainer-tok";
const db = mockDB();
const env = { DB: db, WORKER_TOKEN: W, TRAINER_TOKEN: T };
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
  check((await js(await call("GET", "/checkpoint", null))).status === 401, "no token -> 401 on /checkpoint");
  check((await js(await call("GET", "/checkpoint", "bogus"))).status === 401, "bad token -> 401");
  check((await js(await call("GET", "/shards", W))).status === 403, "WORKER token -> 403 on /shards (trainer-only)");
  check((await js(await call("POST", "/checkpoint", W, { iter: 1, net: {} }))).status === 403, "WORKER token -> 403 on POST /checkpoint");
  check((await js(await call("POST", "/prune", W, { ids: [1] }))).status === 403, "WORKER token -> 403 on /prune");

  // empty checkpoint
  { const r = await js(await call("GET", "/checkpoint", W)); check(r.status === 200 && r.body.net === null && r.body.iter === 0, "empty checkpoint -> {iter:0,net:null}"); }

  // worker appends shards
  check((await js(await call("POST", "/shard", W, { workerId: "w1", samples: [{ x: [1], pi: [1], legal: [true], z: 1 }] }))).body.ok === true, "worker POST /shard ok");
  await call("POST", "/shard", W, { workerId: "w2", samples: [{ z: -1 }] });
  check((await js(await call("POST", "/shard", W, { workerId: "w1", samples: [] }))).status === 400, "empty samples -> 400");

  // stats
  { const r = await js(await call("GET", "/stats", W)); check(r.body.pendingShards === 2, "stats reports 2 pending shards"); }

  // trainer pulls, publishes checkpoint, prunes
  { const r = await js(await call("GET", "/shards", T, undefined)); check(r.body.shards.length === 2 && r.body.shards[0].samples[0].z === 1, "trainer GET /shards returns both with parsed samples"); }
  check((await js(await call("POST", "/checkpoint", T, { iter: 7, net: { nHid: 48 } }))).body.iter === 7, "trainer publishes checkpoint");
  { const r = await js(await call("GET", "/checkpoint", W)); check(r.body.iter === 7 && r.body.net.nHid === 48, "worker reads published checkpoint"); }
  { const ids = (await js(await call("GET", "/shards", T))).body.shards.map((s) => s.id);
    check((await js(await call("POST", "/prune", T, { ids }))).body.pruned === 2, "trainer prunes consumed shards"); }
  check((await js(await call("GET", "/stats", W))).body.pendingShards === 0, "shard queue empty after prune");

  // bad route
  check((await js(await call("GET", "/nope", W))).status === 404, "unknown route -> 404");

  console.log(`\nworker-api test: ${ok} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
