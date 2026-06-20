/* engine/verify_sync.js — end-to-end test of the sync client against the REAL Worker handler.
 *
 * Stubs global fetch to route az_sync's HTTP calls through worker-api/src/index.js backed by an
 * in-memory mock D1 — so it exercises the actual request/response contract (and the auth boundary)
 * with no wrangler/Cloudflare/network. Run: node engine/verify_sync.js
 */
"use strict";
const { makeSync } = require("./az_sync.js");

function mockDB() {
  const st = { checkpoint: null, shards: [], nextId: 1 };
  return {
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
        async all() { if (sql.includes("FROM shards")) { const lim = args[0] || 100; return { results: st.shards.slice(0, lim).map((s) => ({ id: s.id, samples: s.samples })) }; } return { results: [] }; },
        async run() {
          if (sql.startsWith("INSERT INTO shards")) st.shards.push({ id: st.nextId++, samples: args[2] });
          else if (sql.startsWith("INSERT INTO checkpoint")) st.checkpoint = { iter: args[0], net: args[1] };
          else if (sql.startsWith("DELETE FROM shards")) { const ids = new Set(args); st.shards = st.shards.filter((s) => !ids.has(s.id)); }
          return { success: true };
        },
      };
    },
  };
}

let ok = 0, fail = 0;
const check = (c, m) => { if (c) ok++; else { fail++; console.error("  ✗ " + m); } };

(async () => {
  const worker = (await import("../worker-api/src/index.js")).default;
  const env = { DB: mockDB(), WORKER_TOKEN: "wtok", TRAINER_TOKEN: "ttok" };
  global.fetch = (url, opts) => worker.fetch(new Request(url, opts), env);   // az_sync's fetch -> the real Worker

  const w = makeSync({ apiUrl: "https://bus.test", token: "wtok", workerId: "w1" });
  const t = makeSync({ apiUrl: "https://bus.test", token: "ttok", workerId: "trainer" });
  const bad = makeSync({ apiUrl: "https://bus.test", token: "nope", workerId: "x" });

  // empty checkpoint
  check((await w.getCheckpoint()).net === null, "getCheckpoint() empty -> net null");
  // bad token rejected (4xx -> throws, no retry)
  let threw = false; try { await bad.getCheckpoint(); } catch (e) { threw = e.status === 401; } check(threw, "bad token -> 401 thrown");
  // worker forbidden from trainer routes
  threw = false; try { await w.getShards(); } catch (e) { threw = e.status === 403; } check(threw, "worker token -> 403 on getShards");
  threw = false; try { await w.putCheckpoint({ iter: 1, net: {} }); } catch (e) { threw = e.status === 403; } check(threw, "worker token -> 403 on putCheckpoint");

  // worker pushes shards
  await w.putShard([{ x: [1], pi: [1], legal: [true], z: 1 }], "w1");
  await w.putShard([{ z: -1 }, { z: 1 }], "w1");
  check((await w.stats()).pendingShards === 2, "two shards queued");

  // trainer publishes a checkpoint, worker reads it back
  await t.putCheckpoint({ iter: 5, nIn: 48, nHid: 48, nPol: 15, W1: [], b1: [], Wv: [], bv: 0, Wp: [], bp: [] });
  const ck = await w.getCheckpoint();
  check(ck.iter === 5 && ck.net && ck.net.nHid === 48, "worker reads the published checkpoint");

  // trainer consumes + prunes
  const { shards } = await t.getShards(100);
  check(shards.length === 2 && shards[0].samples[0].z === 1, "trainer getShards returns parsed samples");
  check((await t.prune(shards.map((s) => s.id))).pruned === 2, "trainer prunes consumed shards");
  check((await w.stats()).pendingShards === 0, "queue empty after prune");

  console.log(`\nverify_sync (az_sync <-> Worker, in-process): ${ok} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
