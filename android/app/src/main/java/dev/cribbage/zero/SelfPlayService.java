package dev.cribbage.zero;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

/**
 * Foreground service that runs the native actor ({@link NativeBridge#runActor}) on a background thread, with
 * a partial wake-lock (CPU stays awake screen-off) and a persistent notification. Started/stopped from the
 * WebView via {@link MainActivity}'s JS bridge. The actor pulls the net from GitHub, self-plays, and uploads
 * sample shards to the data bus until stopped.
 */
public class SelfPlayService extends Service {
    public static final String ACTION_START = "dev.cribbage.zero.START";
    public static final String ACTION_STOP = "dev.cribbage.zero.STOP";
    private static final String CHANNEL = "cz_actor";
    private static final int NOTIF_ID = 1;

    // observed by MainActivity's JS bridge (isRunning / status)
    public static volatile boolean running = false;
    public static volatile String status = "";

    private Thread worker;
    private PowerManager.WakeLock wake;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL, "Cribbage Zero actor", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Background self-play for the trainer");
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            signalStop();
            return START_NOT_STICKY;
        }
        if (running) return START_STICKY;   // already running — ignore a duplicate start

        final String repo = extra(intent, "repo", "ghug/cribbage-zero");
        final String busUrl = extra(intent, "busUrl", "");
        final String busToken = extra(intent, "busToken", "");
        final String token = extra(intent, "token", "");
        final int sims = intInt(intent, "sims", 40);
        final int workers = intInt(intent, "workers", 2);
        final int pairs = intInt(intent, "pairs", 20);
        final int shardMax = intInt(intent, "shardMax", 1500);

        running = true;
        status = "starting…";
        startForegroundNotif();
        acquireWake();

        worker = new Thread(() -> {
            try {
                status = "running";
                updateNotif();
                String result = NativeBridge.runActor(repo, busUrl, busToken, token, sims, workers, pairs, shardMax);
                status = result;
            } catch (Throwable t) {
                status = "error: " + t.getMessage();
                Log.e("cz", "actor crashed", t);
            } finally {
                running = false;
                updateNotif();
                releaseWake();
                stopForeground(true);
                stopSelf();
            }
        }, "cz-actor");
        worker.start();
        return START_STICKY;
    }

    private void signalStop() {
        // tell the native loop to finish its current round and return; the worker thread then cleans up.
        try { NativeBridge.stopActor(); } catch (Throwable ignored) {}
        status = "stopping…";
        updateNotif();
    }

    @Override
    public void onDestroy() {
        signalStop();
        releaseWake();
        super.onDestroy();
    }

    // ---- notification ----
    private void startForegroundNotif() {
        Notification n = buildNotif();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    private void updateNotif() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null && running) nm.notify(NOTIF_ID, buildNotif());
    }

    private Notification buildNotif() {
        Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        return b.setContentTitle("Cribbage Zero — self-play")
                .setContentText(status == null || status.isEmpty() ? "running" : status)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setOngoing(true)
                .build();
    }

    // ---- wake lock ----
    private void acquireWake() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "cz:actor");
                wake.setReferenceCounted(false);
                wake.acquire();
            }
        } catch (Throwable ignored) {}
    }

    private void releaseWake() {
        try { if (wake != null && wake.isHeld()) wake.release(); } catch (Throwable ignored) {}
        wake = null;
    }

    private static String extra(Intent i, String key, String def) {
        if (i == null) return def;
        String v = i.getStringExtra(key);
        return v != null ? v : def;
    }

    private static int intInt(Intent i, String key, int def) {
        return i == null ? def : i.getIntExtra(key, def);
    }
}
