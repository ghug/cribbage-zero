/* Real-browser end-to-end test of the device worker.
 *
 * Serves worker.html + the engine bundle on one port, and the ACTUAL Worker API (worker-api/src/index.js
 * over an in-memory D1, seeded with a checkpoint) on another — so the page's fetch is genuinely
 * cross-origin (exercises CORS). Then a headless Chromium opens worker.html, pastes a token, clicks
 * Start, and we assert the Web Worker self-plays, shards POST, and the "iterations pushed" counter climbs.
 *
 * Run: node test/browser.mjs   (after `bash engine/build-bundle.sh`)
 */
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const worker = (await import("../worker-api/src/index.js")).default;
const { freshNet, netToObj } = require("../engine/az_common.js");

/* ---- in-memory D1, seeded with a small-net checkpoint so the worker gets a net immediately ---- */
function mockDB(seedObj) {
  const st = { checkpoint: { iter: seedObj.iter, net: JSON.stringify(seedObj) }, shards: [], nextId: 1 };
  return {
    _st: st,
    prepare(sql) {
      let a = [];
      return {
        bind(...x) { a = x; return this; },
        async first() {
          if (sql.includes("SELECT iter, net FROM checkpoint")) return st.checkpoint ? { iter: st.checkpoint.iter, net: st.checkpoint.net } : null;
          if (sql.includes("COUNT(*)")) return { n: st.shards.length };
          if (sql.includes("SELECT iter FROM checkpoint")) return st.checkpoint ? { iter: st.checkpoint.iter } : null;
          return null;
        },
        async all() { if (sql.includes("FROM shards")) return { results: st.shards.slice(0, a[0] || 100).map((s) => ({ id: s.id, samples: s.samples })) }; return { results: [] }; },
        async run() {
          if (sql.startsWith("INSERT INTO shards")) st.shards.push({ id: st.nextId++, samples: a[2] });
          else if (sql.startsWith("INSERT INTO checkpoint")) st.checkpoint = { iter: a[0], net: a[1] };
          else if (sql.startsWith("DELETE FROM shards")) { const ids = new Set(a); st.shards = st.shards.filter((s) => !ids.has(s.id)); }
          return { success: true };
        },
      };
    },
  };
}

const db = mockDB(netToObj(freshNet(8), 1445));    // tiny net → fast self-play in the browser
const env = { DB: db, WORKER_TOKEN: "wtok", TRAINER_TOKEN: "ttok" };

/* ---- API server (the real Worker handler) ---- */
const api = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request("http://localhost" + req.url, { method: req.method, headers: req.headers, body: (req.method === "GET" || req.method === "HEAD") ? undefined : body });
  const r = await worker.fetch(request, env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
});

/* ---- static server (worker.html + worker/*) ---- */
const CT = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
const stat = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/worker.html";
  if (p === "/favicon.ico") { res.writeHead(204); return res.end(); }   // browsers auto-request this
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("404"); }
  res.writeHead(200, { "Content-Type": CT[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

function chromePath() {
  if (process.env.PW_CHROME) return process.env.PW_CHROME;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  for (const g of fs.readdirSync(base)) if (g.startsWith("chromium-")) { const x = path.join(base, g, "chrome-linux", "chrome"); if (fs.existsSync(x)) return x; }
  return undefined;   // let playwright resolve
}

let ok = 0, fail = 0; const check = (c, m) => { if (c) ok++; else { fail++; console.error("  ✗ " + m); } };

await new Promise((r) => api.listen(0, r));
await new Promise((r) => stat.listen(0, r));
const API = api.address().port, WEB = stat.address().port;

const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console.error: " + m.text()); });

  await page.goto(`http://localhost:${WEB}/worker.html`);
  check(await page.$("#start") !== null, "worker.html loaded (Start button present)");

  await page.fill("#api", `http://localhost:${API}`);
  await page.fill("#tok", "wtok");
  await page.fill("#games", "2");
  await page.fill("#sims", "8");
  await page.click("#start");

  // the Web Worker must self-play and the main thread must POST shards → counter climbs to >=2
  await page.waitForFunction(() => parseInt(document.getElementById("count").textContent, 10) >= 2, null, { timeout: 90000 });
  const count = parseInt(await page.textContent("#count"), 10);
  check(count >= 2, `counter reached ${count} (Web Worker self-played + shards posted)`);

  const logTxt = await page.textContent("#log");
  check(/iter 1445/.test(logTxt), "page pulled the seeded checkpoint (iter 1445)");
  check(db._st.shards.length >= 2, `API received ${db._st.shards.length} shards`);
  check(JSON.parse(db._st.shards[0].samples)[0].z !== undefined, "shard samples are well-formed (have z)");
  check(errs.length === 0, "no uncaught page/console errors" + (errs.length ? " — " + errs.slice(0, 3).join(" | ") : ""));

  await page.click("#stop");
} finally {
  await browser.close(); api.close(); stat.close();
}

console.log(`\nbrowser E2E: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
