package dev.designyourtv;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;

import dev.designyourtv.core.BacklightLogic;

/**
 * The eco backlight on the real panel. Xiaomi's TvService watches Settings.Global "picture_backlight" (0-100) and
 * drives the LED PWM from it (the kernel logs "[MTGVDO_SetArg] backlight value: N"). We hold WRITE_SECURE_SETTINGS
 * (granted over adb for the density switch), which also covers Settings.Global. Undo by hand:
 * adb shell settings put global picture_backlight 100
 */
final class Eco {
    private static final String KEY = "picture_backlight", PREFS = "eco";
    private static final Handler H = new Handler(Looper.getMainLooper());
    private static long lastKey = SystemClock.elapsedRealtime();
    private static Context app;
    private static boolean on;
    private static boolean appMode;             // the level now held is another app's (a music app's), set by appFront
    private static int level = -1;              // -1: the wallpaper's eco then AOD steps
    private static int night = -1;              // the wallpaper's night mode (OK on the bare wallpaper), -1 off
    private static volatile boolean dark;       // the dock's screen-off button: backlight 0 until the next remote key (S5 step 6)
    static final int READING = 70;

    private Eco() {}

    private static final Runnable TICK = new Runnable() { @Override public void run() { apply(); } };

    /** The wallpaper came to the front. */
    static void start(Context c) { start(c, -1); }

    /** A screen with its own fixed level: Claude and the Dashboard read at READING (70: text reads
     *  fine there); video apps keep the owner's level. */
    static void start(Context c, int fixed) { appMode = false; app = c.getApplicationContext(); level = fixed; on = true; lastKey = SystemClock.elapsedRealtime(); apply(); }

    /** Another app is in front (HomeKeyService, S5 step 2): a music app holds its mid level, anything else gets the owner's own
     *  level back. Only undoes what this call did, so our own screens' levels are never touched from here. */
    static void appFront(Context c, int lv) {
        if (on && !appMode) return;             // our own screen, the music cover or the screensaver holds the panel: not ours to change
        if (lv >= 0) { start(c, lv); appMode = true; }
        else stop(c);                           // also after a process kill (appMode lost, record kept): puts his level back, a no-op with no record
    }

    /** Night mode from the wallpaper page: 1-35 holds that level until it lets go (-1) or the wallpaper leaves. */
    static void night(final int lv) {
        H.post(new Runnable() { @Override public void run() { night = lv >= 1 && lv <= 35 ? lv : -1; if (on) apply(); } });
    }

    /** The dock's screen-off button (native): backlight to 0 at once (no glide, no timer), the app stays in
     *  front so adb stays reachable. Ends on the next remote key (Web.key calls light), or when the wallpaper leaves the
     *  front (stop puts his level back). Nothing here repeats or watches anything. */
    static boolean darken(Context c) {
        if (!on) start(c);                      // the wallpaper is the front screen, so on is already true; belt and braces
        H.removeCallbacks(TICK);
        dark = true;
        BacklightLogic.Result r = BacklightLogic.dim(panel(app, true), store(app), 0);
        Log.i(Density.TAG, "eco dark: " + r);
        if (r == BacklightLogic.Result.FAILED) { dark = false; return false; }
        return true;
    }

    /** Any remote key while dark: his level back (the page's own level follows through apply). */
    static void light() {
        if (!dark || app == null) return;
        dark = false;
        BacklightLogic.Result r = BacklightLogic.restore(panel(app, true), store(app));
        Log.i(Density.TAG, "eco light: " + r);
        if (on) apply();
    }

    static boolean isDark() { return dark; }

    /** A remote press: back up from the AOD level. */
    static void poke() { lastKey = SystemClock.elapsedRealtime(); if (on && !dark) apply(); }

    /** The wallpaper left the front (an app opened, the TV slept, the dream ended). */
    static void stop(Context c) {
        // night is kept: coming back to a page still in night mode (it never left it) must land dark again, not at
        // eco. The page lets go itself with night(-1) when it leaves night mode or boots fresh.
        on = false; appMode = false; dark = false; H.removeCallbacks(TICK);
        BacklightLogic.Result r = BacklightLogic.restore(panel(c), store(c));
        Log.i(Density.TAG, "eco restore: " + r);
    }

    /** After a boot or an update: if our dim was left behind, put his level back. */
    static void restoreIfActive(Context c) { if (!on) stop(c); }

    private static void apply() {
        if (!on || app == null || dark) return;
        long idle = SystemClock.elapsedRealtime() - lastKey;
        boolean fixed = level >= 0 || night > 0;
        BacklightLogic.Result r = BacklightLogic.dim(panel(app), store(app), level >= 0 ? level : night > 0 ? night : BacklightLogic.target(idle));
        if (r == BacklightLogic.Result.FAILED) Log.w(Density.TAG, "eco dim failed");
        H.removeCallbacks(TICK);
        if (fixed) return;                      // a fixed level (a reading screen, night mode) has no AOD step
        if (idle < BacklightLogic.AOD_AFTER_MS) H.postDelayed(TICK, BacklightLogic.AOD_AFTER_MS - idle + 1000);
    }

    // A level change glides over RAMP_MS in small steps, so the panel fades with the page's veils instead of jumping
    // (3 Nov: the night veil took 700 ms and the backlight snapped under it). While a glide runs, get() answers its
    // target, so BacklightLogic never mistakes our own in-between steps for the owner changing the level.
    static final int RAMP_MS = 700, RAMP_STEPS = 14;
    private static volatile int rampTo = -1;
    private static int rampGen;

    private static BacklightLogic.Panel panel(final Context c) { return panel(c, false); }

    /** direct: write the level at once, no glide (the screen-off button must not leave a 700 ms timer behind). */
    private static BacklightLogic.Panel panel(final Context c, final boolean direct) {
        return new BacklightLogic.Panel() {
            @Override public Integer get() {
                int t = rampTo;
                if (t >= 0) return t;
                try { return Settings.Global.getInt(c.getContentResolver(), KEY); } catch (Exception e) { return null; }
            }
            @Override public boolean set(int v) {
                Integer from;
                try { from = Settings.Global.getInt(c.getContentResolver(), KEY); } catch (Exception e) { from = null; }
                if (from == null || from == v || direct) { rampGen++; rampTo = -1; return write(c, v); }
                if (!write(c, from + (v - from) / RAMP_STEPS)) return false;   // the first step proves the write is allowed
                glide(c, from, v);
                return true;
            }
        };
    }

    private static boolean write(Context c, int v) {
        try { return Settings.Global.putInt(c.getContentResolver(), KEY, v); }
        catch (Exception e) { Log.w(Density.TAG, "backlight write refused", e); return false; }
    }

    /** Steps 2..N on the main looper; a newer glide cancels this one (its generation no longer matches). */
    private static void glide(final Context c, final int from, final int to) {
        final int gen = ++rampGen;
        rampTo = to;
        for (int i = 2; i <= RAMP_STEPS; i++) {
            final int step = i;
            H.postDelayed(new Runnable() { @Override public void run() {
                if (gen != rampGen) return;
                // ease-out: most of the change early, the last few levels settle gently
                double t = (double) step / RAMP_STEPS, e = 1 - (1 - t) * (1 - t);
                write(c, step == RAMP_STEPS ? to : (int) Math.round(from + (to - from) * e));
                if (step == RAMP_STEPS) rampTo = -1;
            } }, (long) RAMP_MS * (step - 1) / (RAMP_STEPS - 1));
        }
    }

    private static BacklightLogic.Store store(final Context c) {
        final SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return new BacklightLogic.Store() {
            @Override public Integer prev() { return p.contains("prev") ? p.getInt("prev", 100) : null; }
            @Override public Integer ours() { return p.contains("ours") ? p.getInt("ours", 0) : null; }
            @Override public boolean save(Integer prev, Integer ours) {
                SharedPreferences.Editor e = p.edit();
                if (prev == null) e.remove("prev"); else e.putInt("prev", prev);
                if (ours == null) e.remove("ours"); else e.putInt("ours", ours);
                return e.commit();                               // durable before the panel changes
            }
        };
    }
}
