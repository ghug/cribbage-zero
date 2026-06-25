// Single source of truth for app config, loaded first on every page (before chrome.js).
//   CZ_VERSION — displayed version. On `dev` it is <next-patch>-dev.<n>: bump <n> by one on every
//     code-changing dev commit; a release drops the -dev.<n> suffix and bumps the patch. Keep
//     android/app/build.gradle versionName in step on an APK release.
//   CZ_REPO    — the GitHub repo the tools read/write (net branch, snapshots, bus admin).
//   CZ_BUS_URL — the Cloudflare data-bus Worker base URL.
window.CZ_VERSION = "0.1.41-dev.8";
window.CZ_REPO = "ghug/cribbage-zero";
window.CZ_BUS_URL = "https://cribbage-zero-bus.gabrielhug.workers.dev";
