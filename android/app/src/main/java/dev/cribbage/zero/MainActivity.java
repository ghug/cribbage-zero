package dev.cribbage.zero;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Cribbage Zero trainer: one full-screen WebView that loads the bundled local.html. The page trains
 * the net on-device by self-play and pushes it to GitHub. Needs INTERNET (GitHub API) and file-URL
 * access (the engine bundle + fetch from the file:// origin).
 */
public class MainActivity extends Activity {

    /** Set by the actor notification's PendingIntent — asks us to surface the actor page (if it's still running). */
    public static final String EXTRA_OPEN_ACTOR = "openActor";

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        web.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);                 // localStorage (token + checkpoint)
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setAllowFileAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);  // fetch the GitHub API from the file:// origin

        // bridge for the worker/monitor page to start/stop the native background actor (APK only).
        web.addJavascriptInterface(new CzBridge(), "CZAndroid");
        requestNotificationsPermission();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                // top-level navigations to external links open in the system browser; fetch/XHR from the
                // page do NOT trigger this, so the GitHub API calls stay in-app.
                if ("http".equals(scheme) || "https".equals(scheme) || "mailto".equals(scheme)) {
                    try {
                        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(intent);
                    } catch (ActivityNotFoundException ignored) {
                    }
                    return true;
                }
                return false;
            }
        });

        boolean openActor = wantsActor(getIntent());
        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
            if (openActor) web.loadUrl(ACTOR_URL);             // tapped the notification → jump to the actor page
        } else {
            // launched from the actor notification while it's running → go straight to the actor page,
            // otherwise the tools hub (index.html routes to the saved mode).
            web.loadUrl(openActor ? ACTOR_URL : "file:///android_asset/index.html");
        }

        setContentView(web);
    }

    private static final String ACTOR_URL = "file:///android_asset/actor.html";

    /** True when the launch intent is the actor notification AND the actor is still running. */
    private static boolean wantsActor(Intent intent) {
        return intent != null && intent.getBooleanExtra(EXTRA_OPEN_ACTOR, false) && SelfPlayService.running;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        // singleTop: the activity (and its loaded WebView page) is reused. Only navigate when the notification
        // tap asks for the actor page and the actor is still running; otherwise leave the current page as-is.
        super.onNewIntent(intent);
        setIntent(intent);
        if (web != null && wantsActor(intent)) {
            String url = web.getUrl();
            if (url == null || !url.endsWith("actor.html")) web.loadUrl(ACTOR_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    private void requestNotificationsPermission() {
        // API 33+: the foreground-service notification only shows if POST_NOTIFICATIONS is granted.
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
            try { requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1); } catch (Exception ignored) {}
        }
    }

    /**
     * JS bridge exposed to the bundled pages as window.CZAndroid (present only in the APK, so the web build
     * can feature-detect it). Lets the monitor page start/stop the native background actor and read its state.
     */
    private final class CzBridge {
        @JavascriptInterface
        public void startActor(String busUrl, String busToken, String token, String repo,
                               int sims, int workers, int pairs, int shardMax, int refreshMin,
                               boolean notifyOnFail) {
            Intent i = new Intent(MainActivity.this, SelfPlayService.class);
            i.setAction(SelfPlayService.ACTION_START);
            i.putExtra("busUrl", busUrl);
            i.putExtra("busToken", busToken);
            i.putExtra("token", token);
            i.putExtra("repo", repo);
            i.putExtra("sims", sims);
            i.putExtra("workers", workers);
            i.putExtra("pairs", pairs);
            i.putExtra("shardMax", shardMax);
            i.putExtra("refreshMin", refreshMin);
            i.putExtra("notifyOnFail", notifyOnFail);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
        }

        @JavascriptInterface
        public void stopActor() {
            Intent i = new Intent(MainActivity.this, SelfPlayService.class);
            i.setAction(SelfPlayService.ACTION_STOP);
            startService(i);
        }

        // ---- native eval (eval.html): run a vs-random / vs-hard match in C++ on a background thread ----
        @JavascriptInterface
        public boolean hasNativeEval() { return true; }

        @JavascriptInterface
        public void startEval(String repo, String token, int which, int decks) {
            if (NativeBridge.evalRunning) return;
            NativeBridge.evalRunning = true; NativeBridge.evalProgress = 0; NativeBridge.evalResult = "";
            new Thread(() -> {
                String r;
                try { r = NativeBridge.runEval(repo, token, which, decks); }
                catch (Throwable t) { r = "error: " + (t.getMessage() == null ? t.toString() : t.getMessage()); }
                NativeBridge.evalResult = r; NativeBridge.evalRunning = false;
            }, "cz-eval").start();
        }

        @JavascriptInterface
        public boolean evalRunning() { return NativeBridge.evalRunning; }

        @JavascriptInterface
        public double evalProgress() { return NativeBridge.evalProgress; }

        @JavascriptInterface
        public String evalResult() { return NativeBridge.evalResult; }

        @JavascriptInterface
        public boolean isRunning() { return SelfPlayService.running; }

        @JavascriptInterface
        public String status() { return SelfPlayService.status == null ? "" : SelfPlayService.status; }

        @JavascriptInterface
        public String log() { return SelfPlayService.getLog(); }
    }
}
