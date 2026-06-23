/* netstore.js — shared net storage for Cribbage Zero (window.CZNet).
 *
 * No build step: pages load <script src="netstore.js"></script>. One per-origin IndexedDB layer plus a
 * single shared "last cloud net" cache, so the cloud net is pulled once and reused by every page — no page
 * re-downloads a net another page already has, or one we just pushed. Storage is per-ORIGIN (shared across
 * all pages, same as cz_token/cz_repo in chrome.js), so nothing here is page-private.
 *
 * IndexedDB DB "cribbage-zero", store "ckpt", holds exactly two FIXED keys, both OVERWRITTEN on write
 * (never keyed per-iter → it cannot accumulate multiples):
 *   cz_local_ckpt — local.html's in-progress TRAINING net (may be ahead of / unpushed to the cloud)
 *   cz_cloud_net  — the last net pulled-from / pushed-to GitHub: { obj, iter, games }
 */
(function () {
  "use strict";
  var DB_NAME = "cribbage-zero", STORE = "ckpt", CLOUD_KEY = "cz_cloud_net";
  var BRANCH = "net", CKPATH = "checkpoints/az_checkpoint.json", INFOPATH = "checkpoints/info.json";

  // ---- IndexedDB layer (cached handle so put() structured-clones synchronously = a clean snapshot) ----
  var dbHandle = null;
  function openDB() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  var dbReady = openDB().then(function (db) { dbHandle = db; }).catch(function (e) { try { console.warn("CZNet: IndexedDB unavailable —", e && e.message); } catch (x) {} });

  function get(key) {
    return dbReady.then(function () {
      return new Promise(function (res, rej) {
        if (!dbHandle) return res(undefined);
        var rq = dbHandle.transaction(STORE, "readonly").objectStore(STORE).get(key);
        rq.onsuccess = function () { res(rq.result); }; rq.onerror = function () { rej(rq.error); };
      });
    });
  }
  function put(key, obj) {   // synchronous structured-clone snapshot when the handle is ready; skips otherwise
    if (!dbHandle) return;
    try { dbHandle.transaction(STORE, "readwrite").objectStore(STORE).put(obj, key); }
    catch (e) { try { console.warn("CZNet: put failed —", e && e.message); } catch (x) {} }
  }
  function del(key) {
    return dbReady.then(function () {
      return new Promise(function (res, rej) {
        if (!dbHandle) return res();
        var tx = dbHandle.transaction(STORE, "readwrite"); tx.objectStore(STORE).delete(key);
        tx.oncomplete = function () { res(); }; tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  // ---- cloud net (GitHub `net` branch) + the shared cz_cloud_net cache ----
  function rawHeaders(token) { var H = { Accept: "application/vnd.github.raw", "X-GitHub-Api-Version": "2022-11-28" }; if (token) H.Authorization = "Bearer " + token; return H; }
  function ghFetch(repo, path, token) { return fetch("https://api.github.com/repos/" + repo + "/contents/" + path + "?ref=" + BRANCH, { headers: rawHeaders(token), cache: "no-store" }); }

  async function info(repo, token) {   // small {games, iter} probe — read before downloading the multi-MB net
    var res = await ghFetch(repo, INFOPATH, token);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("info -> " + res.status);
    return JSON.parse(await res.text());
  }
  async function download(repo, token) {   // the net itself via the RAW media type (multi-MB, > the 1MB JSON-inline cap)
    var res = await ghFetch(repo, CKPATH, token);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("net -> " + res.status);
    return JSON.parse(await res.text());
  }
  function cached() { return get(CLOUD_KEY).then(function (c) { return c || null; }); }
  function setCloud(obj, iter, games) { return dbReady.then(function () { put(CLOUD_KEY, { obj: obj, iter: iter || 0, games: games || 0 }); }); }

  // The last cloud net, reusing the shared cache when its iter matches info.json (no re-download). Pass a
  // pre-fetched `inf` (info.json result) to skip the internal probe; pass undefined to have it fetched.
  async function latest(repo, token, inf) {
    if (inf === undefined) { try { inf = await info(repo, token); } catch (e) { inf = null; } }
    var c = await cached();
    if (inf) {
      if (c && c.obj && (c.iter || 0) === (inf.iter || 0))
        return { obj: c.obj, iter: c.iter || 0, games: (inf.games != null ? inf.games : c.games) || 0, fromCache: true };
      var obj = await download(repo, token);
      if (!obj) return (c && c.obj) ? { obj: c.obj, iter: c.iter || 0, games: c.games || 0, fromCache: true } : null;
      await setCloud(obj, obj.iter || 0, obj.games || 0);
      return { obj: obj, iter: obj.iter || 0, games: obj.games || 0, fromCache: false };
    }
    // info unavailable (no info.json / rate-limited): prefer the cache, else try the net directly
    if (c && c.obj) return { obj: c.obj, iter: c.iter || 0, games: c.games || 0, fromCache: true };
    var o2 = await download(repo, token);
    if (!o2) return null;
    await setCloud(o2, o2.iter || 0, o2.games || 0);
    return { obj: o2, iter: o2.iter || 0, games: o2.games || 0, fromCache: false };
  }

  window.CZNet = {
    ready: dbReady,
    get: get, put: put, del: del,            // generic store (cz_local_ckpt lives here too)
    info: info, cached: cached, latest: latest, setCloud: setCloud,
    PATHS: { net: CKPATH, info: INFOPATH, branch: BRANCH },
  };
})();
