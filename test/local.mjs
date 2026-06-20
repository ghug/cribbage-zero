/* Real-browser test of the on-device trainer (local.html), token blank so it stays fully local (no
 * GitHub calls). Serves local.html + the bundle, runs a few iterations, and asserts the iteration
 * counter climbs, the net persists to localStorage, and it resumes on reload. Run: node test/local.mjs
 * (after `bash engine/build-bundle.sh`). The GitHub push path is validated separately. */
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CT = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };

const stat = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/local.html";
  if (p === "/favicon.ico") { res.writeHead(204); return res.end(); }
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("404"); }
  res.writeHead(200, { "Content-Type": CT[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

function chromePath() {
  if (process.env.PW_CHROME) return process.env.PW_CHROME;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  for (const g of fs.readdirSync(base)) if (g.startsWith("chromium-")) { const x = path.join(base, g, "chrome-linux", "chrome"); if (fs.existsSync(x)) return x; }
  return undefined;
}

let ok = 0, fail = 0; const check = (c, m) => { if (c) ok++; else { fail++; console.error("  ✗ " + m); } };

await new Promise((r) => stat.listen(0, r));
const WEB = stat.address().port;
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console.error: " + m.text()); });
  // fail loudly if the page ever tries to reach GitHub with a blank token
  page.on("request", (r) => { if (/api\.github\.com/.test(r.url())) errs.push("unexpected GitHub call: " + r.url()); });

  await page.goto(`http://localhost:${WEB}/local.html`);
  check(await page.$("#start") !== null, "local.html loaded");
  await page.fill("#token", "");          // blank → fully local, no pushing
  await page.fill("#games", "2");
  await page.fill("#sims", "8");
  await page.fill("#push", "999");
  await page.click("#start");

  const N = (s) => parseInt(String(s).replace(/[^0-9]/g, ""), 10);   // headline shows "games trained" (with commas)
  await page.waitForFunction(() => parseInt(document.getElementById("count").textContent.replace(/[^0-9]/g, ""), 10) >= 2, null, { timeout: 90000 });
  const games = N(await page.textContent("#count"));
  check(games >= 2, `headline shows ${games} games trained (games, not iters)`);
  const log = await page.textContent("#log");
  check(/loss/.test(log), "training logged a loss");
  await page.click("#wind");   // graceful: finish the current iteration, then stop
  await page.waitForFunction(() => !document.getElementById("start").disabled, null, { timeout: 20000 });
  check(/winding down/.test(await page.textContent("#log")), "wind-down finished the iteration then stopped");

  const saved = await page.evaluate(() => { const o = JSON.parse(localStorage.getItem("cz_local_ckpt") || "null"); return o && Array.isArray(o.W1) && typeof o.games === "number" ? o.games : -1; });
  check(saved >= 2, `cumulative games persisted to the checkpoint (games ${saved})`);

  // resume: reload and confirm the games headline persists
  await page.reload();
  await page.waitForFunction(() => parseInt(document.getElementById("count").textContent.replace(/[^0-9]/g, ""), 10) >= 2, null, { timeout: 10000 });
  const resumed = N(await page.textContent("#count"));
  check(resumed === saved, `resumed games headline ${resumed} (saved ${saved})`);

  check(errs.length === 0, "no uncaught errors / no GitHub calls" + (errs.length ? " — " + errs.slice(0, 2).join(" | ") : ""));
} finally {
  await browser.close(); stat.close();
}
console.log(`\nlocal trainer E2E: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
