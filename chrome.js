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
  ].join("");

  function node(html) { var d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; }

  function build() {
    if (document.getElementById("cz-icons")) return;
    var style = document.createElement("style"); style.id = "cz-chrome-style"; style.textContent = CSS;
    document.head.appendChild(style);

    var ver = window.CZ_VERSION || "";
    var icons = node('<div id="cz-icons"><a id="cz-home" class="cz-icon" href="dev.html" aria-label="Home — dev tools" title="Tools home">⌂</a>' +
      '<button id="cz-gear" class="cz-icon" type="button" aria-label="Settings">⚙</button>' +
      '<button id="cz-info" class="cz-icon" type="button" aria-label="About">ⓘ</button></div>');

    var settings = node('<div id="cz-settings" class="cz-overlay" role="dialog" aria-modal="true" aria-label="Settings"><div class="cz-modal">' +
      '<div class="cz-modal-head"><h2>Settings</h2><button class="cz-done" type="button" data-close>Done</button></div>' +
      '<label for="cz-token">GitHub token (Contents: write)</label>' +
      '<input id="cz-token" type="password" placeholder="ghp_… — leave blank for read-only" autocapitalize="off" autocorrect="off" autocomplete="off" />' +
      '<label class="cz-check"><input id="cz-remember" type="checkbox" /> Remember token on this device (otherwise in-memory only)</label>' +
      '<label for="cz-repo">Repo (owner/name)</label>' +
      '<input id="cz-repo" type="text" placeholder="' + REPO_DEFAULT + '" autocapitalize="off" autocorrect="off" />' +
      '<button id="cz-openabout" class="cz-done cz-full" type="button">About Cribbage Zero</button>' +
      '</div></div>');

    var about = node('<div id="cz-about" class="cz-overlay" role="dialog" aria-modal="true" aria-label="About"><div class="cz-modal">' +
      '<div class="cz-modal-head"><h2>About</h2><button class="cz-done" type="button" data-close>Done</button></div>' +
      '<p>An open-source, from-scratch <b>AlphaZero-style</b> cribbage engine: a neural network guided by ' +
      'Monte-Carlo Tree Search learns cribbage purely from self-play. The trained net lives on the GitHub ' +
      '<b>net</b> branch; many devices contribute self-play and one learner trains + republishes it.</p>' +
      '<p>Version ' + ver + ' · public domain (The Unlicense).</p>' +
      '<p><a href="https://github.com/ghug/cribbage-zero" target="_blank" rel="noopener noreferrer">Source, bugs &amp; feedback ↗</a></p>' +
      '</div></div>');

    document.body.appendChild(icons); document.body.appendChild(settings); document.body.appendChild(about);

    var tokIn = document.getElementById("cz-token"), remIn = document.getElementById("cz-remember"), repoIn = document.getElementById("cz-repo");
    var savedTok = localStorage.getItem("cz_token"); if (savedTok) { tokIn.value = savedTok; remIn.checked = true; }
    repoIn.value = localStorage.getItem("cz_repo") || REPO_DEFAULT;

    function persistToken() { var t = tokIn.value.trim(); if (remIn.checked && t) localStorage.setItem("cz_token", t); else localStorage.removeItem("cz_token"); }
    function persistRepo() { localStorage.setItem("cz_repo", repoIn.value.trim() || REPO_DEFAULT); }
    remIn.addEventListener("change", persistToken);
    tokIn.addEventListener("change", persistToken);
    repoIn.addEventListener("change", persistRepo);

    function show(o) { o.classList.add("cz-on"); } function hide(o) { o.classList.remove("cz-on"); }
    document.getElementById("cz-gear").addEventListener("click", function () { show(settings); });
    document.getElementById("cz-info").addEventListener("click", function () { show(about); });
    document.getElementById("cz-openabout").addEventListener("click", function () { hide(settings); show(about); });
    [settings, about].forEach(function (o) { o.addEventListener("click", function (e) { if (e.target === o || e.target.hasAttribute("data-close")) { persistToken(); persistRepo(); hide(o); } }); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") { persistToken(); persistRepo(); hide(settings); hide(about); } });
  }

  // Global accessors — read live from the inputs (so an un-remembered, in-memory token still works), with a
  // localStorage fallback for code that runs before the chrome DOM is built.
  window.CZ = {
    token: function () { var i = document.getElementById("cz-token"); return (i ? i.value.trim() : "") || ""; },
    repo: function () { var i = document.getElementById("cz-repo"); return (i && i.value.trim()) || localStorage.getItem("cz_repo") || REPO_DEFAULT; },
    persist: function () { var t = document.getElementById("cz-token"), r = document.getElementById("cz-remember"), p = document.getElementById("cz-repo");
      if (t && r) { var v = t.value.trim(); if (r.checked && v) localStorage.setItem("cz_token", v); else localStorage.removeItem("cz_token"); }
      if (p) localStorage.setItem("cz_repo", p.value.trim() || REPO_DEFAULT); },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
