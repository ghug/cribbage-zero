package dev.cribbage.zero;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.text.TextUtils;
import android.util.Log;

import java.util.ArrayDeque;

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
    private static final String ALERT_CHANNEL = "cz_alert";
    private static final int NOTIF_ID = 1;
    private static final int ALERT_ID = 2;

    // observed by MainActivity's JS bridge (isRunning / status / log)
    public static volatile boolean running = false;
    public static volatile String status = "";
    // when true, a bus-upload failure escalates to a high-priority heads-up notification (actor page toggle)
    private static volatile boolean alertsEnabled = false;
    // live instance, so the static native callback postAlert() has a Context to notify from
    private static SelfPlayService instance;
    // recent progress lines (latest last) for the actor page's live readout — fed by the native log callback
    private static final ArrayDeque<String> LOG = new ArrayDeque<>();

    public static void pushLog(String m) {
        synchronized (LOG) { LOG.addLast(m); while (LOG.size() > 16) LOG.removeFirst(); }
        status = m;
    }

    public static String getLog() {
        synchronized (LOG) { return TextUtils.join("\n", LOG); }
    }

    private static void clearLog() {
        synchronized (LOG) { LOG.clear(); }
    }

    private Thread worker;
    private PowerManager.WakeLock wake;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL, "Cribbage Zero actor", NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("Background self-play for the trainer");
                nm.createNotificationChannel(ch);
                // a separate HIGH-importance channel so an upload-failure alert can pop as a heads-up
                NotificationChannel al = new NotificationChannel(
                        ALERT_CHANNEL, "Cribbage Zero alerts", NotificationManager.IMPORTANCE_HIGH);
                al.setDescription("Bus-upload failures while self-playing");
                nm.createNotificationChannel(al);
            }
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
        final int refreshMin = intInt(intent, "refreshMin", 10);
        alertsEnabled = intent != null && intent.getBooleanExtra("notifyOnFail", false);

        running = true;
        clearLog();
        pushLog("starting…");
        startForegroundNotif();
        acquireWake();

        worker = new Thread(() -> {
            try {
                pushLog("connecting…");
                updateNotif();
                String result = NativeBridge.runActor(repo, busUrl, busToken, token, sims, workers, pairs, shardMax, refreshMin);
                pushLog(result);
            } catch (Throwable t) {
                pushLog("error: " + t.getMessage());
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
        pushLog("stopping…");
        updateNotif();
    }

    @Override
    public void onDestroy() {
        // Only signal-stop if the loop is still active (e.g. the system is killing us mid-run). A normal
        // finish already reset `running` and logged "actor finished" — re-signalling here would overwrite
        // that with a spurious "stopping…".
        if (running) signalStop();
        releaseWake();
        if (instance == this) instance = null;
        super.onDestroy();
    }

    /**
     * Escalated bus-failure alert, invoked from the native callback ({@link NativeBridge#onActorAlert}).
     * No-op unless the user enabled the actor page's "alert me if uploads fail" toggle. Posts a high-priority
     * heads-up notification (separate from the ongoing one) that opens the actor page when tapped.
     */
    public static void postAlert(String m) {
        SelfPlayService self = instance;
        if (!alertsEnabled || self == null) return;
        try {
            Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
                    ? new Notification.Builder(self, ALERT_CHANNEL)
                    : new Notification.Builder(self).setPriority(Notification.PRIORITY_HIGH);
            Notification n = b.setContentTitle("Cribbage Zero — upload failing")
                    .setContentText(m == null ? "bus upload failed" : m)
                    .setStyle(new Notification.BigTextStyle().bigText(m == null ? "bus upload failed" : m))
                    .setSmallIcon(android.R.drawable.stat_notify_error)
                    .setContentIntent(self.openActorIntent())
                    .setAutoCancel(true)
                    .build();
            NotificationManager nm = self.getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(ALERT_ID, n);
        } catch (Throwable ignored) {}
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
                .setContentIntent(openActorIntent())
                .setOngoing(true)
                .build();
    }

    // Tapping the notification reopens MainActivity (singleTop → reuses the existing WebView/page) and asks it
    // to show the actor page. MainActivity only navigates if the actor is still running; otherwise it just
    // surfaces whatever page was already loaded.
    private PendingIntent openActorIntent() {
        Intent i = new Intent(this, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .putExtra(MainActivity.EXTRA_OPEN_ACTOR, true)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
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
