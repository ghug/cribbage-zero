/* chrome.js — shared top-right Settings + About menu for every Cribbage Zero page.
 *
 * No build step: each page just loads <script src="version.js"></script><script src="chrome.js"></script>.
 * It injects the fixed ⚙ / ⓘ buttons and the Settings + About modals (identical on every page) and owns the
 * GLOBAL settings used across pages — the GitHub token (localStorage "cz_token", opt-in remember) and the
 * repo (localStorage "cz_repo"). Page-specific knobs stay as inline inputs on each page. Pages read the
 * globals via window.CZ.token() / window.CZ.repo(). Styles/classes are namespaced (cz-*) so they can't clash
 * with a host page's own CSS, and use the shared theme vars (with fallbacks) so it looks the same everywhere.
 */
(function () {
  "use strict";
  var REPO_DEFAULT = "ghug/cribbage-zero";
  var BUS_DEFAULT = "https://cribbage-zero-bus.gabrielhug.workers.dev";

  // A credential held in a closure var (seeded from a remembered copy) — NEVER in the input's value, so the
  // secret never sits in the DOM where any element / script / screenshot / autofill could read it. The input is
  // write-only: typing a value captures it here and clears the field; presence is shown by a label. Two of these:
  // the GitHub token (net/snapshot admin) and the bus worker token (contribute self-play).
  function tokenField(opts) {   // { storeKey, legacyKey?, inputId, rememberId, stateId, clearId, placeholderEmpty }
    if (opts.legacyKey && !localStorage.getItem(opts.storeKey)) {       // one-time migrate an old key to the cz_* one
      var lv = localStorage.getItem(opts.legacyKey); if (lv) { localStorage.setItem(opts.storeKey, lv); localStorage.removeItem(opts.legacyKey); }
    }
    var mem = localStorage.getItem(opts.storeKey) || "";
    function render() {
      var st = document.getElementById(opts.stateId), inp = document.getElementById(opts.inputId), clr = document.getElementById(opts.clearId);
      if (!st || !inp || !clr) return;
      var has = !!mem;
      st.textContent = has ? "✓ set" : "not set";
      st.className = "cz-tokstate" + (has ? " cz-tokset" : "");
      inp.placeholder = has ? "•••••••• — paste to replace" : opts.placeholderEmpty;
      clr.style.display = has ? "" : "none";
    }
    function commit() {   // pull a freshly-typed value into memory, wipe the field, mirror to storage per "remember"
      var inp = document.getElementById(opts.inputId), rem = document.getElementById(opts.rememberId);
      if (inp) { var t = inp.value.trim(); if (t) { mem = t; inp.value = ""; } }
      if (rem) { if (rem.checked && mem) localStorage.setItem(opts.storeKey, mem); else localStorage.removeItem(opts.storeKey); }
      render();
    }
    function wire() {
      var inp = document.getElementById(opts.inputId), rem = document.getElementById(opts.rememberId), clr = document.getElementById(opts.clearId);
      if (rem) rem.checked = !!localStorage.getItem(opts.storeKey);
      if (inp) inp.addEventListener("change", commit);
      if (rem) rem.addEventListener("change", commit);
      if (clr) clr.addEventListener("click", function () { mem = ""; if (inp) inp.value = ""; localStorage.removeItem(opts.storeKey); render(); });
      render();
    }
    return { get: function () { return mem; }, commit: commit, wire: wire };
  }
  var gitTok = tokenField({ storeKey: "cz_token", inputId: "cz-token", rememberId: "cz-remember", stateId: "cz-token-state", clearId: "cz-token-clear", placeholderEmpty: "ghp_… — leave blank for read-only" });
  var workerTok = tokenField({ storeKey: "cz_worker_token", legacyKey: "az_tok", inputId: "cz-wtok", rememberId: "cz-wremember", stateId: "cz-wtok-state", clearId: "cz-wtok-clear", placeholderEmpty: "worker token — to contribute self-play" });
  var trainerTok = tokenField({ storeKey: "cz_trainer_token", inputId: "cz-ttok", rememberId: "cz-tremember", stateId: "cz-ttok-state", clearId: "cz-ttok-clear", placeholderEmpty: "trainer token — drain · lease" });

  // one compact token block: label + write-only input + a single meta row (Remember · state · Forget)
  function tokenHtml(inputId, rememberId, stateId, clearId, label, placeholder) {
    return '<label for="' + inputId + '">' + label + '</label>' +
      '<input id="' + inputId + '" type="password" placeholder="' + placeholder + '" autocapitalize="off" autocorrect="off" autocomplete="off" />' +
      '<div class="cz-tokmeta"><label class="cz-check"><input id="' + rememberId + '" type="checkbox" /> Remember</label>' +
      '<span id="' + stateId + '" class="cz-tokstate"></span>' +
      '<button id="' + clearId + '" class="cz-link" type="button">Forget</button></div>';
  }

  var CSS = [
    "#cz-icons{position:fixed;top:max(10px,env(safe-area-inset-top));right:12px;display:flex;gap:8px;z-index:60}",
    ".cz-icon{width:34px;height:34px;border-radius:9px;border:1px solid var(--line,#2f6b4d);background:rgba(0,0,0,.28);",
      "color:var(--ink,#f3ecd6);font-size:16px;line-height:1;cursor:pointer;text-decoration:none;display:flex;align-items:center;justify-content:center}",
    ".cz-icon:hover{border-color:var(--gold,#d6bc7a)}",
    ".cz-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:70;padding:18px}",
    ".cz-overlay.cz-on{display:flex}",
    ".cz-modal{width:100%;max-width:430px;max-height:88vh;overflow:auto;background:var(--bg2,#1c4d37);border:1px solid var(--line,#2f6b4d);",
      "border-radius:14px;padding:16px 18px;color:var(--ink,#f3ecd6);font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 16px 40px rgba(0,0,0,.4)}",
    ".cz-modal-head{display:flex;align-items:center;justify-content:space-between;margin:0 0 12px}",
    ".cz-modal-head h2{font-size:16px;margin:0}",
    ".cz-modal label{display:block;font-size:12.5px;color:var(--mut,#a9c4b3);margin:12px 0 4px}",
    ".cz-modal input[type=password],.cz-modal input[type=text],.cz-modal input:not([type]){width:100%;box-sizing:border-box;padding:9px 11px;",
      "border-radius:9px;border:1px solid var(--line,#2f6b4d);background:rgba(0,0,0,.28);color:var(--ink,#f3ecd6);font-size:14px}",
    ".cz-check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--mut,#a9c4b3);margin:8px 0 0;cursor:pointer}",
    ".cz-check input{width:auto;margin:0}",
    ".cz-done{border:1px solid var(--line,#2f6b4d);background:rgba(255,255,255,.1);color:var(--ink,#f3ecd6);border-radius:9px;padding:7px 14px;font-size:13px;cursor:pointer}",
    ".cz-done:hover{border-color:var(--gold,#d6bc7a)}",
    ".cz-full{width:100%;margin-top:14px}",
    ".cz-modal a{color:var(--gold,#d6bc7a)}",
    ".cz-modal p{color:var(--mut,#a9c4b3);font-size:13px}",
    ".cz-sub{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--gold,#d6bc7a);margin:16px 0 2px;border-top:1px solid var(--line,#2f6b4d);padding-top:12px}",
    ".cz-tokmeta{display:flex;align-items:center;gap:10px;margin:5px 0 2px}",
    ".cz-tokmeta .cz-check{margin:0;flex:0 0 auto}",
    ".cz-tokstate{flex:1 1 auto;font-size:12px;color:var(--mut,#a9c4b3)}",
    ".cz-tokstate.cz-tokset{color:var(--good,#6fbf8e)}",
    ".cz-link{flex:0 0 auto;background:none;border:0;color:var(--gold,#d6bc7a);font:inherit;font-size:12px;cursor:pointer;padding:0;text-decoration:underline}",
  ].join("");

  function node(html) { var d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; }

  function build() {
    if (document.getElementById("cz-icons")) return;
    var style = document.createElement("style"); style.id = "cz-chrome-style"; style.textContent = CSS;
    document.head.appendChild(style);

    var ver = window.CZ_VERSION || "";
    // The Home (⌂) link points back to the tools hub. The hub itself (dev.html) sets window.CZ_NO_HOME
    // before loading chrome.js to omit it — it still gets ⚙ Settings + ⓘ About like every other page.
    var home = window.CZ_NO_HOME ? "" :
      '<a id="cz-home" class="cz-icon" href="dev.html" aria-label="Home — dev tools" title="Tools home">⌂</a>';
    var icons = node('<div id="cz-icons">' + home +
      '<button id="cz-gear" class="cz-icon" type="button" aria-label="Settings">⚙</button>' +
      '<button id="cz-info" class="cz-icon" type="button" aria-label="About">ⓘ</button></div>');

    var settings = node('<div id="cz-settings" class="cz-overlay" role="dialog" aria-modal="true" aria-label="Settings"><div class="cz-modal">' +
      '<div class="cz-modal-head"><h2>Settings</h2><button class="cz-done" type="button" data-close>Done</button></div>' +
      '<label for="cz-repo">Repo (owner/name)</label>' +
      '<input id="cz-repo" type="text" placeholder="' + REPO_DEFAULT + '" autocapitalize="off" autocorrect="off" />' +
      '<label for="cz-bus">Data-bus URL</label>' +
      '<input id="cz-bus" type="text" placeholder="' + BUS_DEFAULT + '" autocapitalize="off" autocorrect="off" />' +
      '<div class="cz-sub">Tokens</div>' +
      tokenHtml("cz-token", "cz-remember", "cz-token-state", "cz-token-clear", "GitHub token (Contents: write)", "ghp_… — blank = read-only") +
      tokenHtml("cz-wtok", "cz-wremember", "cz-wtok-state", "cz-wtok-clear", "Worker token (append self-play)", "worker token — append self-play") +
      tokenHtml("cz-ttok", "cz-tremember", "cz-ttok-state", "cz-ttok-clear", "Trainer token (drain · learner lease)", "trainer token — drain · lease") +
      '<button id="cz-openabout" class="cz-done cz-full" type="button">About Cribbage Zero</button>' +
      '</div></div>');

    var about = node('<div id="cz-about" class="cz-overlay" role="dialog" aria-modal="true" aria-label="About"><div class="cz-modal">' +
      '<div class="cz-modal-head"><h2>About</h2><button class="cz-done" type="button" data-close>Done</button></div>' +
      '<p>An open-source, from-scratch cribbage engine: a neural network guided by ' +
      'Monte-Carlo Tree Search learns cribbage purely from self-play. The trained net lives on the GitHub ' +
      '<b>net</b> branch; many devices contribute self-play and one learner trains + republishes it.</p>' +
      '<p>Version ' + ver + ' · public domain (The Unlicense).</p>' +
      '<p><a href="https://github.com/ghug/cribbage-zero" target="_blank" rel="noopener noreferrer">Source, bugs &amp; feedback ↗</a></p>' +
      '</div></div>');

    document.body.appendChild(icons); document.body.appendChild(settings); document.body.appendChild(about);

    var repoIn = document.getElementById("cz-repo"), busIn = document.getElementById("cz-bus");
    repoIn.value = localStorage.getItem("cz_repo") || REPO_DEFAULT;
    busIn.value = localStorage.getItem("cz_bus_url") || BUS_DEFAULT;

    function persistRepo() { localStorage.setItem("cz_repo", repoIn.value.trim() || REPO_DEFAULT); }
    function persistBus() { localStorage.setItem("cz_bus_url", busIn.value.trim() || BUS_DEFAULT); }
    gitTok.wire(); workerTok.wire(); trainerTok.wire();   // all tokens: empty write-only inputs + presence labels, never pre-filled
    repoIn.addEventListener("change", persistRepo);
    busIn.addEventListener("change", persistBus);

    function show(o) { o.classList.add("cz-on"); } function hide(o) { o.classList.remove("cz-on"); }
    document.getElementById("cz-gear").addEventListener("click", function () { show(settings); });
    document.getElementById("cz-info").addEventListener("click", function () { show(about); });
    document.getElementById("cz-openabout").addEventListener("click", function () { hide(settings); show(about); });
    function commitAll() { gitTok.commit(); workerTok.commit(); trainerTok.commit(); persistRepo(); persistBus(); }
    [settings, about].forEach(function (o) { o.addEventListener("click", function (e) { if (e.target === o || e.target.hasAttribute("data-close")) { commitAll(); hide(o); } }); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") { commitAll(); hide(settings); hide(about); } });
  }

  // Global accessors. The token is the in-memory closure var (never read from the DOM); repo/bus read the live
  // input with a localStorage fallback for code that runs before the chrome DOM is built.
  window.CZ = {
    token: function () { return gitTok.get(); },              // GitHub token (Contents: write)
    workerToken: function () { return workerTok.get(); },     // data-bus worker token (append self-play)
    trainerToken: function () { return trainerTok.get(); },   // data-bus trainer token (drain + learner lease)
    busToken: function () { return workerTok.get() || trainerTok.get(); },   // either works for read-only bus monitoring
    repo: function () { var i = document.getElementById("cz-repo"); return (i && i.value.trim()) || localStorage.getItem("cz_repo") || REPO_DEFAULT; },
    busUrl: function () { var i = document.getElementById("cz-bus"); return ((i && i.value.trim()) || localStorage.getItem("cz_bus_url") || BUS_DEFAULT).replace(/\/+$/, ""); },
    persist: function () { gitTok.commit(); workerTok.commit(); trainerTok.commit();   // capture+wipe typed tokens, mirror per "remember"
      var p = document.getElementById("cz-repo"), b = document.getElementById("cz-bus");
      if (p) localStorage.setItem("cz_repo", p.value.trim() || REPO_DEFAULT);
      if (b) localStorage.setItem("cz_bus_url", b.value.trim() || BUS_DEFAULT); },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
