package dev.designyourtv;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.graphics.PixelFormat;
import android.media.AudioManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;

import dev.designyourtv.core.MusicCover;

/**
 * The wallpaper page drawn over YouTube Music while it plays (core/MusicCover.java says why). An accessibility
 * overlay, not an activity: YouTube stays resumed and keeps window focus, so it never stops. The overlay never takes
 * focus; HomeKeyService hands it the remote's keys, D-pad and OK as DOM keys to the page, CH+/CH- as on the wallpaper,
 * Back closes it; play/pause and volume go on to YouTube. Created on show and destroyed on hide: this TV has 1.8 GB.
 */
final class MusicOverlay {
    private final AccessibilityService svc;
    private final Handler h = new Handler(Looper.getMainLooper());
    private Web web;
    private View root;
    private WindowManager.LayoutParams lp;

    MusicOverlay(AccessibilityService s) { svc = s; }

    /** The cover hides YouTube's window, so YouTube's keep-screen-on stops counting and the screensaver would start
     *  and pause it (measured 4 Nov 00:54). The cover keeps the screen on while sound plays and lets go after a
     *  minute of silence, so a paused player still ends in the screensaver as before. */
    private static final long AWAKE_CHECK_MS = 30000;
    private int quiet;
    private final Runnable awake = new Runnable() { @Override public void run() {
        if (root == null) return;
        boolean playing;
        try { playing = ((AudioManager) svc.getSystemService(Context.AUDIO_SERVICE)).isMusicActive(); } catch (Exception ex) { playing = false; }
        quiet = playing ? 0 : quiet + 1;
        boolean on = quiet < 2, was = (lp.flags & WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) != 0;
        if (on != was) {
            if (on) lp.flags |= WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON; else lp.flags &= ~WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON;
            try { ((WindowManager) svc.getSystemService(AccessibilityService.WINDOW_SERVICE)).updateViewLayout(root, lp); } catch (Exception ignored) { }
        }
        h.postDelayed(this, AWAKE_CHECK_MS);
    } };

    boolean shown() { return root != null; }

    void show() {
        if (root != null) return;
        try {
            web = new Web(svc, new Web.Host() {
                @Override public void launched() { hide(); }          // a dock app opened
                @Override public void gone() { hide(); }              // the renderer died: YouTube Music shows again
            });
            root = web.root();
            lp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN | WindowManager.LayoutParams.FLAG_FULLSCREEN
                            | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
                    PixelFormat.OPAQUE);
            lp.setTitle("DesignYourTV music cover");
            lp.windowAnimations = android.R.style.Animation_Toast;   // a short fade, not a cut
            ((WindowManager) svc.getSystemService(AccessibilityService.WINDOW_SERVICE)).addView(root, lp);
            web.start();
            Timers.up(this, web.view());           // the cover is ours on screen: our pages' scripts run
            quiet = 0; h.postDelayed(awake, AWAKE_CHECK_MS);
            Eco.start(svc);                     // the wallpaper's eco backlight, as on the wallpaper activity
            Log.i(Density.TAG, "music cover shown over " + MusicCover.YT);
        } catch (Exception e) {
            Log.w(Density.TAG, "music cover failed", e);
            drop();
        }
    }

    void hide() {
        if (root == null) return;
        Eco.stop(svc);
        drop();
        Log.i(Density.TAG, "music cover hidden");
    }

    private void drop() {
        h.removeCallbacks(awake);
        if (root != null) try { ((WindowManager) svc.getSystemService(AccessibilityService.WINDOW_SERVICE)).removeView(root); } catch (Exception ignored) { }
        if (web != null) { Timers.down(this, web.view()); web.destroy(); }
        root = null; web = null;
    }

    /** A remote key while the cover is up. @return true when used here, false to let it reach YouTube. */
    boolean key(KeyEvent e) {
        if (web == null) return false;
        int k = e.getKeyCode();
        if (web.key(e)) return true;            // CH+/CH-, and Back while the page's drawer is open
        if (MusicCover.isBack(k)) { if (e.getAction() == KeyEvent.ACTION_UP) hide(); return true; }
        String dom = MusicCover.pageKey(k);
        if (dom == null) return false;          // play/pause, next, volume, mute: YouTube's
        String type = e.getAction() == KeyEvent.ACTION_DOWN ? "keydown" : e.getAction() == KeyEvent.ACTION_UP ? "keyup" : null;
        if (type != null) web.view().evaluateJavascript("(document.activeElement||document.body).dispatchEvent(new KeyboardEvent('" + type
                + "',{key:'" + dom + "',repeat:" + (e.getRepeatCount() > 0) + ",bubbles:true,cancelable:true}))", null);
        return true;
    }
}
