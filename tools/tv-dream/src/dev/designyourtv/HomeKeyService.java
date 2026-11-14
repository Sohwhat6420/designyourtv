package dev.designyourtv;

import android.accessibilityservice.AccessibilityService;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.KeyEvent;
import android.view.ViewConfiguration;
import android.view.accessibility.AccessibilityEvent;

import dev.designyourtv.core.MusicCover;
import dev.designyourtv.core.AppBrightness;
import dev.designyourtv.core.UsageFront;

/**
 * The remote's Home button opens the wallpaper page, and so does Google TV's home screen whenever it comes up (power-on,
 * Back out of an app). Google TV stays Android's real Home and setupwraith stays on, so casting keeps working (CleanYourTV's notes: disabling setupwraith on Google TV stops casting).
 *
 * The idea is CleanYourTV's HomeKeyService (github.com/Gathin23/cleanyourtv), written afresh for this TV:
 *  - Home is caught (onKeyEvent) and opens the wallpaper directly, started like an app, not as a Home intent, so
 *    launcherx keeps the Home role and can still open apps for the remote's own buttons (their #1274).
 *  - Home pressed while the wallpaper is already in front goes to Google TV and stays there for 10 minutes.
 *  - Google TV's home screen is followed to the wallpaper only if it is still in front 0.6 s later, so a PS5 waking
 *    the TV over HDMI-CEC (Live TV takes the screen) is never covered.
 *  - At boot launcherx is often on screen before this service is bound, so no window event comes (their #1116): the
 *    usage log says what is in front instead (PACKAGE_USAGE_STATS is already allowed for the density guard).
 *  - While YouTube Music plays, Home draws the wallpaper over the player instead (MusicOverlay; core/MusicCover.java
 *    has the measurements): YouTube Music for TV stops the moment it leaves the screen.
 * On:  settings put secure enabled_accessibility_services dev.designyourtv/.HomeKeyService (+ accessibility_enabled 1)
 * Off: settings delete secure enabled_accessibility_services (or remove it from the list).
 */
public class HomeKeyService extends AccessibilityService {
    static final String LAUNCHER = "com.google.android.apps.tv.launcherx";
    private static final String[] LAUNCHER_HOMES = { LAUNCHER + ".home.HomeActivity", LAUNCHER + ".home.VanillaModeHomeActivity" };
    private static final long SETTLE_MS = 600, GOOGLE_TV_STAY_MS = 10 * 60 * 1000L, USAGE_WINDOW_MS = 10 * 60 * 1000L;

    private final Handler h = new Handler(Looper.getMainLooper());
    private String frontPkg = "", frontCls = "";
    private long googleTvUntil = 0;
    private BroadcastReceiver screenOn;
    private MusicOverlay cover;
    private boolean musicMode;              // YouTube is in front because YouTube Music opened it

    @Override protected void onServiceConnected() {
        super.onServiceConnected();
        cover = new MusicOverlay(this);
        screenOn = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                // power-on: the TV lands on Google TV's home (tv_auto_play_input 0) unless a source took the screen
                h.postDelayed(new Runnable() { @Override public void run() { followHome(); } }, 1200);
            }
        };
        registerReceiver(screenOn, new IntentFilter(Intent.ACTION_SCREEN_ON));
        // At boot, and whenever the service is (re)bound: a bind after Android crashed the service or killed our process comes
        // with no window event, so read what is in front from the usage log and follow Google TV's home to the wallpaper.
        readFrontFromUsage();
        h.postDelayed(new Runnable() { @Override public void run() { followHome(); } }, SETTLE_MS);
    }

    /** Home is caught here and never reaches Android: Android would draw Google TV's home first (it holds the Home
     *  role on Google TV whatever the role setting says, measured 3 Nov evening) and the wallpaper a second later, the
     *  flash he kept seeing. A short press opens the wallpaper at once; on the wallpaper it opens Google TV and stays
     *  there for 10 minutes; held down, it opens Google TV. Projectivy's "override Home button" works the same way. */
    @Override protected boolean onKeyEvent(KeyEvent e) {
        if (e.getKeyCode() != KeyEvent.KEYCODE_HOME) return cover != null && cover.shown() && cover.key(e);
        if (e.getAction() == KeyEvent.ACTION_DOWN) {
            if (e.getRepeatCount() == 0) { longHome = false; h.removeCallbacks(heldHome); h.postDelayed(heldHome, ViewConfiguration.getLongPressTimeout()); }
            return true;
        }
        if (e.getAction() == KeyEvent.ACTION_UP) {
            h.removeCallbacks(heldHome);
            if (!longHome && !e.isCanceled()) {
                boolean audio = audioActive();
                MusicCover.Home go = MusicCover.onHome(cover != null && cover.shown(), frontPkg, musicMode, audio, wallInFront());
                // a warning, not info: this TV's logcat drops info lines (4 Nov), and this is the line to read when Home misbehaves
                Log.w(Density.TAG, "Home: " + go + " (front " + frontPkg + "/" + frontCls + ", music " + musicMode + ", audio " + audio + ")");
                switch (go) {
                    case SHOW_COVER: cover.show(); break;
                    case HIDE_COVER: cover.hide(); holdAppBrightness(frontPkg); break;   // the cover's stop gave his level back: music holds its own again
                    case OPEN_GOOGLE_TV: googleTvUntil = SystemClock.elapsedRealtime() + GOOGLE_TV_STAY_MS; openGoogleTv(); break;
                    default: googleTvUntil = 0; openWall();
                }
            }
        }
        return true;
    }

    private boolean longHome;
    private final Runnable heldHome = new Runnable() { @Override public void run() {
        longHome = true;
        if (cover != null) cover.hide(); googleTvUntil = SystemClock.elapsedRealtime() + GOOGLE_TV_STAY_MS; openGoogleTv();
    } };

    private boolean audioActive() {
        try { return ((AudioManager) getSystemService(Context.AUDIO_SERVICE)).isMusicActive(); } catch (Exception ex) { return false; }
    }

    /** The wallpaper itself, not the Claude or Dashboard screen (same package, other activity). */
    private boolean wallInFront() { return getPackageName().equals(frontPkg) && frontCls.endsWith(".HomeActivity"); }

    @Override public void onAccessibilityEvent(AccessibilityEvent e) {
        if (e.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED || e.getPackageName() == null || e.getClassName() == null) return;
        String pkg = e.getPackageName().toString(), cls = e.getClassName().toString();
        boolean dream = MusicCover.DREAM.equals(cls);   // the framework's activity, in no manifest, so the test below drops it
        if (!dream) try { getPackageManager().getActivityInfo(new ComponentName(pkg, cls), 0); }
        catch (PackageManager.NameNotFoundException notAnActivity) { return; }   // a dialog, toast or panel: the app under it is still in front
        h.removeCallbacks(brightness);                  // a new activity (the screensaver too) cancels a pending brightness call; a dialog returned above and does not
        if (cover != null && cover.shown() && !MusicCover.keepCover(pkg, cls, getPackageName())) cover.hide();   // another app or the screensaver
        if (dream) return;
        frontPkg = pkg; frontCls = cls;
        musicMode = MusicCover.musicModeAfter(musicMode, pkg, getPackageName());
        if (isGoogleTvHome()) h.postDelayed(new Runnable() { @Override public void run() { followHome(); } }, SETTLE_MS);
        if (getPackageName().equals(pkg) && cls.endsWith(".HomeActivity")) musicMode = false;   // the wallpaper ends a music session
        final String settled = pkg;
        h.postDelayed(brightness = new Runnable() { @Override public void run() { holdAppBrightness(settled); } }, SETTLE_MS + 200);
    }

    private Runnable brightness = new Runnable() { @Override public void run() { } };

    /** Per-app backlight (S5 step 2): music apps sit at a mid level, everything else keeps the owner's. Waits for the window to
     *  settle so our own screen's pause (which restores his level) has run first; skipped under the music cover, which
     *  holds the wallpaper's eco level itself, and for our own screens, which set theirs. */
    private void holdAppBrightness(String pkg) {
        if (!pkg.equals(frontPkg) || (cover != null && cover.shown()) || getPackageName().equals(pkg)) return;
        Eco.appFront(this, AppBrightness.levelFor(pkg, getPackageName(), musicMode));
    }

    private boolean isGoogleTvHome() { return LAUNCHER.equals(frontPkg) && isLauncherHomeClass(frontCls); }

    private static boolean isLauncherHomeClass(String cls) {
        for (String c : LAUNCHER_HOMES) if (c.equals(cls)) return true;
        return false;
    }

    /** Only ever from Google TV's own home, and only when the usage log, read now, agrees it is still in front: a cached
     *  frontPkg can be stale (the service re-binds with no window event), and "never over any app" is his rule (6 Nov). */
    private void followHome() {
        if (!isGoogleTvHome() || SystemClock.elapsedRealtime() < googleTvUntil) return;
        UsageFront u = usageNow();
        if (u == null || !u.known() || !LAUNCHER.equals(u.pkg()) || !isLauncherHomeClass(u.cls())) {
            Log.w(Density.TAG, "followHome: the usage log does not show Google TV's home in front (" + (u == null ? "unreadable" : u.pkg() + "/" + u.cls()) + "); screen left alone");
            return;
        }
        openWall();
    }

    /** The usage log's view of what is in front now (10 minutes of events), or null when it cannot be read. */
    private UsageFront usageNow() {
        try {
            UsageStatsManager um = (UsageStatsManager) getSystemService(Context.USAGE_STATS_SERVICE);
            long now = System.currentTimeMillis();
            UsageEvents ev = um.queryEvents(now - USAGE_WINDOW_MS, now);
            UsageEvents.Event x = new UsageEvents.Event();
            UsageFront f = new UsageFront();
            while (ev.hasNextEvent()) {
                ev.getNextEvent(x);
                int t = x.getEventType();
                if (t == UsageEvents.Event.MOVE_TO_FOREGROUND) f.add(x.getTimeStamp(), true, x.getPackageName(), x.getClassName());
                else if (t == UsageEvents.Event.MOVE_TO_BACKGROUND) f.add(x.getTimeStamp(), false, x.getPackageName(), x.getClassName());
            }
            return f;
        } catch (Exception ex) { Log.w(Density.TAG, "usage log unreadable", ex); return null; }
    }

    private void openWall() {
        try {
            // CATEGORY_HOME without ACTION_MAIN: HomeActivity treats it as Home (Back stays), Android does not
            startActivity(new Intent(this, HomeActivity.class).addCategory(Intent.CATEGORY_HOME)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED));
        } catch (Exception ex) { Log.w(Density.TAG, "could not open the wallpaper", ex); }
    }

    private void openGoogleTv() {
        try {
            startActivity(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
                    .setComponent(new ComponentName(LAUNCHER, LAUNCHER_HOMES[0])).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception ex) { Log.w(Density.TAG, "could not open Google TV", ex); }
    }

    /** At boot: the last activity the usage log saw resume in the past 3 minutes. */
    private void readFrontFromUsage() {
        UsageFront u = usageNow();
        if (u != null && u.known()) { frontPkg = u.pkg(); frontCls = u.cls(); }
    }

    /** The owner asked for the Home button (tv-apply --home-key on): see HomeToggle. Off on a fresh install. */
    static boolean keep(Context c) { return c.getSharedPreferences("homekey", Context.MODE_PRIVATE).getBoolean("keep", false); }

    /** Keep this service switched on once the owner chose it: the TV dropped it once (3 Nov evening: the setting read null,
     *  so Home went to Google TV again). We hold WRITE_SECURE_SETTINGS for the density switch; called at boot, after an
     *  update and from Home. Never switches the service on by itself: a fresh install, or the owner turning it off in
     *  Settings, stays as the owner left it. */
    static void ensure(Context c) {
        try {
            String me = c.getPackageName() + "/." + HomeKeyService.class.getSimpleName();
            String cur = android.provider.Settings.Secure.getString(c.getContentResolver(), android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            dev.designyourtv.core.A11yList.Plan plan = dev.designyourtv.core.A11yList.plan(cur, me, keep(c));
            if (plan == dev.designyourtv.core.A11yList.Plan.NONE) return;
            if (plan == dev.designyourtv.core.A11yList.Plan.REVIVE) { revive(c, me, cur); return; }
            String next = dev.designyourtv.core.A11yList.with(cur, me);
            android.provider.Settings.Secure.putString(c.getContentResolver(), android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, next);
            android.provider.Settings.Secure.putInt(c.getContentResolver(), android.provider.Settings.Secure.ACCESSIBILITY_ENABLED, 1);
            Log.i(Density.TAG, "Home button service switched back on (was: " + cur + ")");
        } catch (Exception ex) { Log.w(Density.TAG, "could not switch the Home button service on", ex); }
    }

    private static long lastRevive;

    /** Listed in settings but not bound: Android killed our process once (6 Nov: 5 Nov 00:11, low memory), put the service on its
     *  "crashed" list and never rebinds it, so the TV came up in Google TV. Switching the setting off and on clears that. Not
     *  while the process is young (the bind may still be coming) and at most once in 2 minutes. */
    private static void revive(final Context c, String me, final String cur) {
        long now = SystemClock.elapsedRealtime();
        if (now - lastRevive < 120000 || isBound(c)) return;
        try { if (android.os.Build.VERSION.SDK_INT >= 24 && now - android.os.Process.getStartElapsedRealtime() < 30000) return; } catch (Throwable ignored) { }
        lastRevive = now;
        final android.content.ContentResolver cr = c.getContentResolver();
        android.provider.Settings.Secure.putString(cr, android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, dev.designyourtv.core.A11yList.without(cur, me));
        new Handler(Looper.getMainLooper()).postDelayed(new Runnable() { @Override public void run() {
            try {
                android.provider.Settings.Secure.putString(cr, android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, cur);
                android.provider.Settings.Secure.putInt(cr, android.provider.Settings.Secure.ACCESSIBILITY_ENABLED, 1);
                Log.w(Density.TAG, "Home button service was enabled but not bound; toggled it");
            } catch (Exception ex) { Log.w(Density.TAG, "could not toggle the Home button service", ex); }
        } }, 1500);
    }

    /** getEnabledAccessibilityServiceList answers with the BOUND services only. Unknown (no manager) counts as bound: never toggle blind. */
    private static boolean isBound(Context c) {
        try {
            android.view.accessibility.AccessibilityManager am = (android.view.accessibility.AccessibilityManager) c.getSystemService(Context.ACCESSIBILITY_SERVICE);
            if (am == null) return true;
            for (android.accessibilityservice.AccessibilityServiceInfo i : am.getEnabledAccessibilityServiceList(android.accessibilityservice.AccessibilityServiceInfo.FEEDBACK_ALL_MASK)) {
                ComponentName cn = ComponentName.unflattenFromString(i.getId());
                if (cn != null && cn.getPackageName().equals(c.getPackageName()) && cn.getClassName().endsWith("HomeKeyService")) return true;
            }
            return false;
        } catch (Exception ex) { return true; }
    }

    @Override public void onInterrupt() { }

    @Override public void onDestroy() {
        h.removeCallbacksAndMessages(null);
        if (cover != null) cover.hide();
        if (screenOn != null) try { unregisterReceiver(screenOn); } catch (Exception ignored) { }
        super.onDestroy();
    }
}
