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
 * Archiving writes snapshots/<games>g-iter<iter>-<stamp>.json on net-archive (a normal commit, so the
 * branch retains every snapshot). Rollback re-pushes a chosen snapshot as the net branch's orphan commit.
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
function validNet(o) {   // accepts the multi-layer (W/hidden) shape and the legacy single-layer (W1) shape
  if (!o || !Array.isArray(o.Wp) || !Array.isArray(o.bp)) return false;
  if (Array.isArray(o.W)) return Array.isArray(o.W[0]) && Array.isArray(o.W[0][0]) && o.W[0][0].length === o.nIn;
  return Array.isArray(o.W1) && o.W1.length === o.nHid && Array.isArray(o.W1[0]) && o.W1[0].length === o.nIn;
}
function stamp() { const d = new Date().toISOString(); return d.slice(0, 10).replace(/-/g, "") + "-" + d.slice(11, 16).replace(":", ""); }   // 20260621-1830

async function currentNet() {
  const r = await gh("GET", "/repos/" + REPO + "/contents/" + CKPATH + "?ref=" + NET);
  return JSON.parse(unb64(r.content));
}
async function ensureArchiveBranch() {
  try { await gh("GET", "/repos/" + REPO + "/git/ref/heads/" + ARCH); return; }
  catch (e) { if (e.status !== 404) throw e; }
  const base = await gh("GET", "/repos/" + REPO + "/git/ref/heads/" + NET);   // seed net-archive from the current net commit
  await gh("POST", "/repos/" + REPO + "/git/refs", { ref: "refs/heads/" + ARCH, sha: base.object.sha });
  console.log("snapshot: created the net-archive branch");
}

async function doSnapshot() {
  const o = await currentNet();
  if (!validNet(o)) throw new Error("current net looks malformed — refusing to archive it");
  const games = o.games || 0, iter = o.iter || 0;
  const name = games + "g-iter" + iter + "-" + stamp() + ".json";
  await ensureArchiveBranch();
  await gh("PUT", "/repos/" + REPO + "/contents/" + DIR + "/" + name, {
    message: "snapshot net @ " + games + " games (iter " + iter + ")",
    content: b64(JSON.stringify(o)), branch: ARCH });
  console.log("snapshot: archived " + DIR + "/" + name + " on " + ARCH + " (" + games.toLocaleString() + " games, iter " + iter + ")");
}
async function doList() {
  let items; try { items = await gh("GET", "/repos/" + REPO + "/contents/" + DIR + "?ref=" + ARCH); }
  catch (e) { if (e.status === 404) { console.log("snapshot: no snapshots yet"); return; } throw e; }
  items.filter((f) => f.name.endsWith(".json")).sort((a, b) => a.name < b.name ? 1 : -1)
    .forEach((f) => console.log("  " + f.name + "  (" + Math.round(f.size / 1024) + " KB)"));
}
async function doRollback(name) {
  const f = await gh("GET", "/repos/" + REPO + "/contents/" + DIR + "/" + encodeURIComponent(name) + "?ref=" + ARCH);
  const o = JSON.parse(unb64(f.content));
  if (!validNet(o)) throw new Error("snapshot " + name + " looks malformed — not restoring");
  if (!YES) {
    if (!process.stdin.isTTY) { console.log("snapshot: not a TTY — re-run with --yes to roll back"); return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ok = await new Promise((res) => rl.question("snapshot: OVERWRITE the net branch with " + name + " (" + (o.games || 0) + " games, iter " + (o.iter || 0) + ")? [y/N] ", (a) => { rl.close(); res(/^y(es)?$/i.test(a.trim())); }));
    if (!ok) { console.log("snapshot: rollback cancelled"); return; }
  }
  const blob = await gh("POST", "/repos/" + REPO + "/git/blobs", { content: b64(JSON.stringify(o)), encoding: "base64" });
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
