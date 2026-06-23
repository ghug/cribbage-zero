package dev.cribbage.zero;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * JNI bridge to the native Cribbage Zero engine (libczactor.so).
 *
 * The native actor loop ({@link #runActor}) calls back into {@link #httpRequest} for every HTTP request, so
 * networking uses Java's HttpURLConnection (native TLS, no libcurl in the NDK). The actor only GETs the net
 * from GitHub and POSTs sample shards to the bus — it never pushes the net (that is the PC learner's job).
 */
public final class NativeBridge {
    static { System.loadLibrary("czactor"); }

    private NativeBridge() {}

    /** Self-play smoke that exercises the whole engine; returns a status line. */
    public static native String selfPlayBench(int pairs, int sims, int workers);

    /**
     * Run the actor loop (pull net -> self-play -> upload shards -> refresh net) until {@link #stopActor()}.
     * BLOCKS — call on a background thread. Returns a final status line.
     */
    public static native String runActor(String repo, String busUrl, String busToken, String token,
                                         int sims, int workers, int pairsPerRound, int shardMax);

    /** Signal a running actor loop to stop (safe to call from another thread). */
    public static native void stopActor();

    /**
     * Perform one HTTP request — invoked FROM native (on the actor thread). Headers arrive as "Key: Value"
     * lines separated by '\n'. Returns "&lt;status&gt;\n&lt;body&gt;" ("-1\n&lt;message&gt;" on a transport error).
     */
    public static String httpRequest(String method, String url, String body, String headers) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod(method);
            c.setConnectTimeout(20000);
            c.setReadTimeout(120000);
            c.setInstanceFollowRedirects(true);
            if (headers != null && !headers.isEmpty()) {
                for (String line : headers.split("\n")) {
                    int i = line.indexOf(": ");
                    if (i > 0) c.setRequestProperty(line.substring(0, i), line.substring(i + 2));
                }
            }
            if (body != null && !body.isEmpty() && !"GET".equals(method)) {
                byte[] out = body.getBytes("UTF-8");
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(out.length);
                c.getOutputStream().write(out);
            }
            int status = c.getResponseCode();
            InputStream is = (status >= 400) ? c.getErrorStream() : c.getInputStream();
            return status + "\n" + new String(readAll(is), "UTF-8");
        } catch (Exception e) {
            return "-1\n" + (e.getMessage() == null ? e.toString() : e.getMessage());
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static byte[] readAll(InputStream is) throws java.io.IOException {
        if (is == null) return new byte[0];
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = is.read(buf)) >= 0) o.write(buf, 0, n);
        is.close();
        return o.toByteArray();
    }
}
