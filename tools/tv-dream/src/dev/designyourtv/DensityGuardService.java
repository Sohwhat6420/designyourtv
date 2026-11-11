package dev.designyourtv;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import dev.designyourtv.core.GuardState;

/**
 * Watches which app is in front (UsageStatsManager; the GET_USAGE_STATS app-op is set once over adb) and puts the
 * density back once Claude has left the screen, the screen goes off, or Claude never came up. Stops itself after.
 */
public class DensityGuardService extends Service {
    private static final long TICK_MS = 1500;
    private final Handler h = new Handler(Looper.getMainLooper());
    private GuardState guard;
    private String lastFg;
    private boolean warned, anyEver;
    private long startedAt, since;

    private final BroadcastReceiver screenOff = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) { done("screen off"); }
    };

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            long now = System.currentTimeMillis();
            // Every foreground change since the last tick is fed in order, not just the latest one: on the API 33
            // emulator (3 Nov) Claude came up and Home was pressed inside one 1.5 s tick, so "latest only" never saw
            // Claude and the guard waited out its 60 s launch timeout with the screen still at 240 dpi.
            boolean decide = feed(now);
            if (decide || guard.onForeground(lastFg, now)) { done("left Claude (" + lastFg + ")"); return; }
            h.postDelayed(this, TICK_MS);
        }
    };

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(1, notification());
        Log.i(Density.TAG, "guard: started");
        long now = System.currentTimeMillis();
        guard = new GuardState(getPackageName(), now);
        startedAt = now;
        since = now;                                   // events from before this open (an earlier Claude) don't count
        lastFg = null;
        anyEver = false;
        h.removeCallbacks(tick);
        h.postDelayed(tick, TICK_MS);
        try { registerReceiver(screenOff, new IntentFilter(Intent.ACTION_SCREEN_OFF)); } catch (Exception ignored) { }
        return START_NOT_STICKY;
    }

    /** Feeds every MOVE_TO_FOREGROUND (= ACTIVITY_RESUMED, 1) since the last tick to the guard; true = restore now. */
    private boolean feed(long now) {
        boolean decide = false;
        try {
            UsageStatsManager u = (UsageStatsManager) getSystemService(Context.USAGE_STATS_SERVICE);
            UsageEvents ev = u.queryEvents(since, now);
            UsageEvents.Event e = new UsageEvents.Event();
            while (ev.hasNextEvent()) {
                ev.getNextEvent(e);
                anyEver = true;
                if (e.getEventType() != UsageEvents.Event.MOVE_TO_FOREGROUND) continue;
                String p = e.getPackageName();
                long ts = e.getTimeStamp();
                if (!p.equals(lastFg)) Log.i(Density.TAG, "guard: in front now " + p);
                lastFg = p;
                if (guard.onForeground(p, ts)) decide = true;
                if (ts >= since) since = ts + 1;
            }
            if (!anyEver && !warned && now - startedAt > 10000) { warned = true; Log.w(Density.TAG, "guard: no usage events: is GET_USAGE_STATS allowed for us?"); }
        } catch (Exception ex) {
            if (!warned) { warned = true; Log.w(Density.TAG, "guard: usage events unreadable: " + ex); }
        }
        return decide;
    }

    private void done(String why) {
        Log.i(Density.TAG, "guard: " + why);
        h.removeCallbacks(tick);
        Density.restoreIfActive(this);
        stopSelf();
    }

    private Notification notification() {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            nm.createNotificationChannel(new NotificationChannel("guard", "Claude screen size", NotificationManager.IMPORTANCE_MIN));
            b = new Notification.Builder(this, "guard");
        } else {
            b = new Notification.Builder(this);
        }
        return b.setContentTitle("Claude is using the large layout").setSmallIcon(android.R.drawable.ic_menu_zoom).build();
    }

    @Override public void onDestroy() {
        h.removeCallbacks(tick);
        try { unregisterReceiver(screenOff); } catch (Exception ignored) { }
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent i) { return null; }
}
