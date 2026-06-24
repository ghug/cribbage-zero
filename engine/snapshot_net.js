#!/usr/bin/env node
/* engine/snapshot_net.js — archive / restore Cribbage Zero net checkpoints.
 *
 * The live `net` branch is a single orphan commit (no history) to keep it small, so it can't be rolled
 * back on its own. This tool keeps milestone copies on a separate `net-archive` branch (normal history,
 * one file per snapshot) so you always have restore points — without bloating every training push.
 *
 *   CZ_TOKEN=<pat> node engine/snapshot_net.js                 # archive the current net -> net-archive
 *   node engine/snapshot_net.js --list                         # list snapshots (token-less ok on a public repo)
 *   CZ_TOKEN=<pat> node engine/snapshot_net.js --rollback <name>   # restore a snapshot onto the net branch (asks y/N)
 *   ... --rollback <name> --yes                                # restore without the prompt
 *
 * Archiving writes snapshots/<date>-<time>-<games>g-iter<iter>.json on net-archive (e.g.
 * 20260623-2307-180000g-iter360.json) — a normal commit, so the branch retains every snapshot. The leading
 * UTC date-time sorts the snapshots chronologically by filename. Rollback re-pushes a chosen snapshot as the
 * net branch's orphan commit.
 */
"use strict";
const readline = require("readline");

const REPO = process.env.CZ_REPO || "ghug/cribbage-zero";
const NET = "net", ARCH = "net-archive", CKPATH = "checkpoints/az_checkpoint.json", DIR = "snapshots";
const TOKEN = process.env.CZ_TOKEN || "";
const argv = process.argv.slice(2);
const LIST = argv.includes("--list");
const YES = argv.includes("--yes") || argv.includes("-y");
const rbI = argv.indexOf("--rollback");
const ROLLBACK = rbI >= 0 ? argv[rbI + 1] : null;

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s) => Buffer.from(s, "base64").toString("utf8");
async function gh(method, p, body) {
  const headers = { Accept: "application/vnd.github+json", "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cz-snapshot" };
  if (TOKEN) headers.Authorization = "Bearer " + TOKEN;
  const res = await fetch("https://api.github.com" + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const txt = await res.text(); let j = null; try { j = JSON.parse(txt); } catch (e) {}
  if (res.status >= 400) { const e = new Error(method + " " + p.split("?")[0] + " -> " + res.status + (j && j.message ? " " + j.message : "")); e.status = res.status; throw e; }
  return j;
}
function validNet(o) {   // accepts the C++ flat-W shape, the JS nested-W shape, and the legacy single-layer (W1)
  if (!o || !Array.isArray(o.Wp) || !Array.isArray(o.bp)) return false;
  if (Array.isArray(o.W) && o.W.length) {
    const l0 = o.W[0];
    if (!Array.isArray(l0) || !l0.length || !o.nIn) return false;
    if (Array.isArray(l0[0])) return l0[0].length === o.nIn;          // JS nested [dout][din]
    return typeof l0[0] === "number" && l0.length % o.nIn === 0;       // C++ flat row-major (dout*din)
  }
  return Array.isArray(o.W1) && o.W1.length === o.nHid && Array.isArray(o.W1[0]) && o.W1[0].length === o.nIn;
}
function stamp() { const d = new Date().toISOString(); return d.slice(0, 10).replace(/-/g, "") + "-" + d.slice(11, 16).replace(":", ""); }   // 20260621-1830 (UTC)

// GET a file's content via the RAW media type — the net is multi-MB and the JSON repr only inlines ≤1MB.
async function ghRaw(p) {
  const headers = { Accept: "application/vnd.github.raw", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cz-snapshot" };
  if (TOKEN) headers.Authorization = "Bearer " + TOKEN;
  const res = await fetch("https://api.github.com" + p, { headers });
  if (res.status >= 400) { const e = new Error("GET " + p.split("?")[0] + " -> " + res.status); e.status = res.status; throw e; }
  return res.text();
}
// append a file to a branch via the git data API (handles multi-MB files; contents PUT effectively caps ~1MB)
async function appendFile(branch, path, content, message) {
  const ref = await gh("GET", "/repos/" + REPO + "/git/ref/heads/" + branch);
  const base = await gh("GET", "/repos/" + REPO + "/git/commits/" + ref.object.sha);
  const blob = await gh("POST", "/repos/" + REPO + "/git/blobs", { content: b64(content), encoding: "base64" });
  const tree = await gh("POST", "/repos/" + REPO + "/git/trees", { base_tree: base.tree.sha, tree: [{ path, mode: "100644", type: "blob", sha: blob.sha }] });
  const commit = await gh("POST", "/repos/" + REPO + "/git/commits", { message, tree: tree.sha, parents: [ref.object.sha] });
  await gh("PATCH", "/repos/" + REPO + "/git/refs/heads/" + branch, { sha: commit.sha });
}
async function currentNetText() { return ghRaw("/repos/" + REPO + "/contents/" + CKPATH + "?ref=" + NET); }
async function ensureArchiveBranch() {
  try { await gh("GET", "/repos/" + REPO + "/git/ref/heads/" + ARCH); return; }
  catch (e) { if (e.status !== 404) throw e; }
  const base = await gh("GET", "/repos/" + REPO + "/git/ref/heads/" + NET);   // seed net-archive from the current net commit
  await gh("POST", "/repos/" + REPO + "/git/refs", { ref: "refs/heads/" + ARCH, sha: base.object.sha });
  console.log("snapshot: created the net-archive branch");
}

async function doSnapshot() {
  const text = await currentNetText();
  const o = JSON.parse(text);
  if (!validNet(o)) throw new Error("current net looks malformed — refusing to archive it");
  const games = o.games || 0, iter = o.iter || 0;
  const name = stamp() + "-" + games + "g-iter" + iter + ".json";
  await ensureArchiveBranch();
  await appendFile(ARCH, DIR + "/" + name, text, "snapshot net @ " + games + " games (iter " + iter + ")");
  console.log("snapshot: archived " + DIR + "/" + name + " on " + ARCH + " (" + games.toLocaleString() + " games, iter " + iter + ")");
}
async function doList() {
  let items; try { items = await gh("GET", "/repos/" + REPO + "/contents/" + DIR + "?ref=" + ARCH); }
  catch (e) { if (e.status === 404) { console.log("snapshot: no snapshots yet"); return; } throw e; }
  items.filter((f) => f.name.endsWith(".json")).sort((a, b) => a.name < b.name ? 1 : -1)
    .forEach((f) => console.log("  " + f.name + "  (" + Math.round(f.size / 1024) + " KB)"));
}
async function doRollback(name) {
  const text = await ghRaw("/repos/" + REPO + "/contents/" + DIR + "/" + encodeURIComponent(name) + "?ref=" + ARCH);
  const o = JSON.parse(text);
  if (!validNet(o)) throw new Error("snapshot " + name + " looks malformed — not restoring");
  if (!YES) {
    if (!process.stdin.isTTY) { console.log("snapshot: not a TTY — re-run with --yes to roll back"); return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ok = await new Promise((res) => rl.question("snapshot: OVERWRITE the net branch with " + name + " (" + (o.games || 0) + " games, iter " + (o.iter || 0) + ")? [y/N] ", (a) => { rl.close(); res(/^y(es)?$/i.test(a.trim())); }));
    if (!ok) { console.log("snapshot: rollback cancelled"); return; }
  }
  const blob = await gh("POST", "/repos/" + REPO + "/git/blobs", { content: b64(text), encoding: "base64" });
  const tree = await gh("POST", "/repos/" + REPO + "/git/trees", { tree: [{ path: CKPATH, mode: "100644", type: "blob", sha: blob.sha }] });
  const commit = await gh("POST", "/repos/" + REPO + "/git/commits", { message: "rollback: net @ iter " + (o.iter || 0) + " (" + (o.games || 0) + " games) from " + name, tree: tree.sha, parents: [] });
  await gh("PATCH", "/repos/" + REPO + "/git/refs/heads/" + NET, { sha: commit.sha, force: true });
  console.log("snapshot: rolled the net branch back to " + name + " @ commit " + commit.sha.slice(0, 8));
}

(async () => {
  if (LIST) return doList();
  if (ROLLBACK) { if (!TOKEN) { console.error("snapshot: set CZ_TOKEN to roll back"); process.exit(1); } return doRollback(ROLLBACK); }
  if (!TOKEN) { console.error("snapshot: set CZ_TOKEN to archive (or pass --list)"); process.exit(1); }
  return doSnapshot();
})().catch((e) => { console.error("snapshot:", e.message); process.exit(1); });
