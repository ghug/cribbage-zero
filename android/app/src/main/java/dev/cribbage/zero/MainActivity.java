package dev.cribbage.zero;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.util.Base64;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;

/**
 * Cribbage Zero trainer: one full-screen WebView that loads the bundled local.html. The page trains
 * the net on-device by self-play and pushes it to GitHub. Needs INTERNET (GitHub API) and file-URL
 * access (the engine bundle + fetch from the file:// origin). Export uses a data: URL, caught by the
 * download listener and written to the app's external files dir.
 */
public class MainActivity extends Activity {

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

        // Export: the page hands us a data:application/json;base64 URL — decode and save it.
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                int comma = url.indexOf(',');
                byte[] data = Base64.decode(url.substring(comma + 1), Base64.DEFAULT);
                File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                File out = new File(dir, "cribbage-zero-net-" + System.currentTimeMillis() + ".json");
                FileOutputStream fos = new FileOutputStream(out);
                fos.write(data);
                fos.close();
                Toast.makeText(this, "Saved net to " + out.getAbsolutePath(), Toast.LENGTH_LONG).show();
            } catch (Exception e) {
                Toast.makeText(this, "Export failed: " + e.getMessage(), Toast.LENGTH_SHORT).show();
            }
        });

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

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl("file:///android_asset/local.html");
        }

        setContentView(web);
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
}
