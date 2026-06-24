// Single source of truth for the displayed app version (loaded by dev.html / local.html / worker.html).
// dev: <next-patch>-dev.<n> — bump <n> by one on every code-changing dev commit; a release drops the
// -dev.<n> suffix and bumps the patch. Keep android/app/build.gradle versionName in step on an APK release.
window.CZ_VERSION = "0.1.40-dev.4";
