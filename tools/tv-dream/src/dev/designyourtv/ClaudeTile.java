package dev.designyourtv;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.widget.TextView;

import dev.designyourtv.core.DensityLogic;
import dev.designyourtv.core.GuardState;

/**
 * The "Claude" tile on the TV home: puts the screen at a desktop-like density (default 240 dpi: 1920 px = 1280 dp),
 * opens Claude full screen, and the guard service puts the density back when Claude leaves the screen.
 *
 *   am start -n dev.designyourtv/.ClaudeTile                 open Claude at the saved dpi
 *   am start -n dev.designyourtv/.ClaudeTile --ei dpi 213    save 213 as the dpi and open
 *   am start -n dev.designyourtv/.ClaudeTile --ez restore true   only put the density back
 */
public class ClaudeTile extends Activity {
    private final Runnable closer = new Runnable() { @Override public void run() { finish(); } };
    private final Handler h = new Handler(Looper.getMainLooper());
    private Runnable pendingLaunch;
    private TextView t;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        t = new TextView(this);
        t.setBackgroundColor(Color.BLACK);
        t.setTextColor(0xFFE8E2D6);
        t.setTypeface(Typeface.create("sans-serif-light", Typeface.NORMAL));
        t.setTextSize(22);
        t.setGravity(Gravity.CENTER);
        setContentView(t);
        handle(getIntent());
    }

    /** singleTask: a second start while this one is still open (for example "--ez restore true" during the short
     *  wait before Claude opens) arrives here, not in onCreate. Measured on the API 33 emulator, 3 Nov: without
     *  this, that restore was silently dropped and the density stayed at 240 until the guard or a reboot. */
    @Override protected void onNewIntent(Intent in) {
        super.onNewIntent(in);
        setIntent(in);
        handle(in);
    }

    private void handle(Intent in) {
        if (pendingLaunch != null) { h.removeCallbacks(pendingLaunch); pendingLaunch = null; }
        h.removeCallbacks(closer);
        // Whatever happens next, a switch left over from a crash (or from the open this one interrupts) is undone first.
        DensityLogic.Result leftover = Density.restoreIfActive(this);
        if (in != null && in.getBooleanExtra("restore", false)) {
            t.setText("Screen size put back (" + leftover + ")");
            h.postDelayed(closer, 1200);
            return;
        }
        if (in != null && in.hasExtra("dpi")) {
            int d = in.getIntExtra("dpi", 240);
            if (DensityLogic.validDpi(d)) Density.saveDpi(this, d);
        }
        final Intent claude = getPackageManager().getLaunchIntentForPackage(GuardState.CLAUDE);
        if (claude == null) {
            // the Android app needs Android 12 and this TV runs 11: open claude.ai's desktop site in our own screen
            try { startActivity(new Intent(this, WebApp.class)); }
            catch (Exception e) { Log.e(Density.TAG, "could not open the Claude screen", e); }
            finish();
            return;
        }
        int dpi = Density.savedDpi(this);
        long delay = 0;
        if (Density.canWrite(this)) {
            DensityLogic.Result r = Density.apply(this, dpi);
            if (r == DensityLogic.Result.APPLIED) {
                Intent g = new Intent(this, DensityGuardService.class);
                if (Build.VERSION.SDK_INT >= 26) startForegroundService(g); else startService(g);
                delay = 450;                        // let the new density settle before Claude lays itself out
            } else if (r == DensityLogic.Result.FAILED) {
                Log.w(Density.TAG, "density switch unavailable; opening Claude at the TV's own size");
            }
            t.setText("Claude");
        } else {
            t.setText("Claude (the large layout needs the one-time adb grant)");
            delay = 1200;
        }
        claude.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        final ClaudeTile self = this;
        pendingLaunch = new Runnable() { @Override public void run() {
            pendingLaunch = null;
            try { startActivity(claude); } catch (Exception e) { Log.e(Density.TAG, "could not start Claude", e); Density.restoreIfActive(self); }
            finish();
        } };
        h.postDelayed(pendingLaunch, delay);
    }

    @Override protected void onDestroy() {
        // Closed before Claude was started (Back during the wait): nothing is left switched.
        if (pendingLaunch != null) { h.removeCallbacks(pendingLaunch); pendingLaunch = null; Density.restoreIfActive(this); }
        super.onDestroy();
    }
}
