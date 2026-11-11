package dev.designyourtv;

import android.app.Activity;
import android.content.ComponentCallbacks2;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.ImageView;
import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * The wallpaper page full screen. Opened from its "Wallpaper" tile, or (only after the owner's yes, by enabling the
 * disabled-by-default HomeAlias) as the TV's Home screen. When it is Home, Back stays here.
 *
 * Out of sight, the page is let go (onStop, or memory trimmed while hidden) and rebuilt when the wallpaper comes back:
 * a live page behind Netflix held 200-360 MB of the TV's 1.8 GB (the app ~90-216 MB, its renderer 106-164 MB, both at
 * oom_adj 0-100 so Android could never take them for the app in front, 4 Nov). The poster covers the rebuild, and the
 * page loads at once from the origin that last worked (Web.start).
 */
public class HomeActivity extends Activity {
    private final Handler h = new Handler(Looper.getMainLooper());
    private Web web;
    private boolean started, resumed;

    /** HomeKeyService + NowPlaying keep our process at oom_adj <= 100, so Android never sends TRIM_MEMORY_COMPLETE on
     *  its own; firing it once no WebView of ours is shown tells Chromium's GPU/Skia layer to purge its GL tile cache. */
    private final Runnable trimComplete = new Runnable() {
        @Override public void run() {
            if (!started && !resumed && web == null && Timers.noneShown()) {
                getApplication().onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_COMPLETE);
            }
        }
    };

    private static final List<Long> deathTimes = new ArrayList<>();
    private static int backoffIndex = 0;
    private static boolean retryPending = false;
    private static boolean retryScheduled = false;
    private static final long[] BACKOFF_DELAYS_MS = { 30000, 60000, 120000 };

    private ImageView fallbackView;
    private Bitmap fallbackBitmap;

    private boolean isContentViewImageView() {
        if (fallbackView != null) return true;
        View content = findViewById(android.R.id.content);
        if (content instanceof android.view.ViewGroup) {
            android.view.ViewGroup vg = (android.view.ViewGroup) content;
            return vg.getChildCount() > 0 && vg.getChildAt(0) instanceof ImageView;
        }
        return false;
    }

    private void clearFallbackPoster() {
        if (fallbackView != null) {
            fallbackView.setImageDrawable(null);
            fallbackView = null;
        }
        if (fallbackBitmap != null) {
            if (!fallbackBitmap.isRecycled()) fallbackBitmap.recycle();
            fallbackBitmap = null;
        }
    }

    private final Runnable resetDeaths = new Runnable() {
        @Override public void run() {
            stableAccumMs = 0;
            stableSince = 0;
            deathTimes.clear();
            backoffIndex = 0;
            retryPending = false;
            retryScheduled = false;
            Web.setSuppressNetwork(false);
            if (web != null) web.checkNow();
            Log.w(Density.TAG, "renderer stable for 60s; death counter reset");
        }
    };

    private final Runnable retryBuild = new Runnable() {
        @Override public void run() {
            retryScheduled = false;
            if (!started) {
                retryPending = true;
                return;
            }
            retryPending = false;
            if (web == null) {
                Log.w(Density.TAG, "retrying wallpaper build after backoff");
                build();
                if (resumed && web != null) {
                    web.view().onResume();
                    Timers.up(HomeActivity.this, web.view());
                }
            }
        }
    };

    private static void pruneDeaths(long now) {
        for (int i = deathTimes.size() - 1; i >= 0; i--) {
            if (now - deathTimes.get(i) > 60000) deathTimes.remove(i);
        }
    }

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        build();
    }

    private void build() {
        if (web != null) return;
        clearFallbackPoster();
        web = new Web(this, new Web.Host() {
            @Override public void launched() { }
            @Override public void gone() { gone(false); }
            @Override public void gone(boolean didCrash) {
                onRendererGone(didCrash);
            }
            @Override public void ready() {
                onPageReady();
            }
        });
        setContentView(web.root());
        web.view().requestFocus();
        web.start();
    }

    private void onRendererGone(boolean didCrash) {
        pauseStable();
        stableAccumMs = 0;
        pageReady = false;
        h.removeCallbacks(resetDeaths);
        if (didCrash) {
            Web.clearLastOrigin();
            Web.setSuppressNetwork(true);
        }
        release("renderer gone (" + (didCrash ? "crashed" : "killed") + ")");
        if (!started) return;

        long now = SystemClock.elapsedRealtime();
        pruneDeaths(now);
        deathTimes.add(now);

        boolean inBackoff = backoffIndex > 0 || deathTimes.size() >= 3;
        if (inBackoff) {
            long delay = BACKOFF_DELAYS_MS[Math.min(backoffIndex, BACKOFF_DELAYS_MS.length - 1)];
            backoffIndex++;
            Log.w(Density.TAG, "renderer died (backoff level " + backoffIndex + "); backing off for " + (delay / 1000) + "s");
            if (!isContentViewImageView()) showFallbackPoster();
            h.removeCallbacks(retryBuild);
            h.postDelayed(retryBuild, delay);
            retryScheduled = true;
            return;
        }

        h.post(new Runnable() {
            @Override public void run() {
                if (!started || web != null) return;
                build();
                if (resumed && web != null) {
                    web.view().onResume();
                    Timers.up(HomeActivity.this, web.view());
                }
            }
        });
    }

    /** The page counts as stable after 60 s ON SCREEN: the time is added up across pauses (an overlay, a quick app switch), not lost. */
    private static final long STABLE_MS = 60000;
    private long stableAccumMs, stableSince;
    private boolean pageReady;

    private void onPageReady() {
        pageReady = true;
        stableAccumMs = 0;
        armStable();
    }

    private void armStable() {
        if (web == null || !pageReady || !resumed) return;
        h.removeCallbacks(resetDeaths);
        stableSince = SystemClock.elapsedRealtime();
        h.postDelayed(resetDeaths, Math.max(0, STABLE_MS - stableAccumMs));
    }

    private void pauseStable() {
        h.removeCallbacks(resetDeaths);
        if (stableSince != 0) { stableAccumMs += SystemClock.elapsedRealtime() - stableSince; stableSince = 0; }
    }

    private void showFallbackPoster() {
        if (isContentViewImageView()) return;
        final ImageView iv = new ImageView(this);
        iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
        iv.setBackgroundColor(Color.BLACK);
        fallbackView = iv;
        setContentView(iv);

        final File f = new File(getFilesDir(), "poster.img");
        if (f.isFile()) {
            new Thread(new Runnable() {
                @Override public void run() {
                    Bitmap bm = null;
                    try {
                        BitmapFactory.Options o = new BitmapFactory.Options();
                        o.inJustDecodeBounds = true;
                        BitmapFactory.decodeFile(f.getPath(), o);
                        o.inSampleSize = o.outWidth > 3000 ? 2 : 1;
                        o.inJustDecodeBounds = false;
                        o.inPreferredConfig = Bitmap.Config.RGB_565;
                        bm = BitmapFactory.decodeFile(f.getPath(), o);
                    } catch (Throwable t) {
                        Log.w(Density.TAG, "fallback poster decode failed: " + t);
                    }
                    final Bitmap decoded = bm;
                    h.post(new Runnable() {
                        @Override public void run() {
                            if (decoded == null) return;
                            if (web != null || fallbackView != iv) {
                                decoded.recycle();
                                return;
                            }
                            if (fallbackBitmap != null && fallbackBitmap != decoded) {
                                fallbackBitmap.recycle();
                            }
                            fallbackBitmap = decoded;
                            iv.setImageBitmap(decoded);
                        }
                    });
                }
            }, "fallback-poster").start();
        }
    }

    /** Detach the root view first, then destroy the WebView and let a plain black view hold the stopped window. */
    private void release(String why) {
        if (web == null) { clearFallbackPoster(); return; }      // the 4 MB fallback bitmap must not outlive the screen (Opus audit, 4 Nov)
        Web old = web;
        web = null;
        pageReady = false;
        stableAccumMs = 0;
        Timers.down(this, old.view());
        View black = new View(this);
        black.setBackgroundColor(Color.BLACK);
        setContentView(black);
        old.destroy();
        clearFallbackPoster();
        Log.w(Density.TAG, "wallpaper page released (" + why + ")");
        if (!started && Timers.noneShown()) {
            h.removeCallbacks(trimComplete);
            h.postDelayed(trimComplete, 150);
        }
    }

    @Override protected void onStart() {
        super.onStart();
        started = true;
        h.removeCallbacks(trimComplete);
        pruneDeaths(SystemClock.elapsedRealtime());
        // Only a crash backoff that is really running holds the wallpaper back. backoffIndex alone is NOT a reason: it stays set until
        // 60 s of stable display, so after one crash every clean return from Netflix sat on the poster for 30-120 s (Opus audit, 4 Nov).
        boolean waiting = retryPending || retryScheduled;
        if (web == null && !waiting) {
            build();
            Log.w(Density.TAG, "wallpaper page rebuilt");
        } else if (web == null) {
            if (retryPending) {
                retryPending = false;
                retryScheduled = false;
                h.removeCallbacks(retryBuild);
                retryBuild.run();
            } else {
                if (!isContentViewImageView()) {
                    showFallbackPoster();
                }
                if (!retryScheduled) {
                    long delay = BACKOFF_DELAYS_MS[Math.min(Math.max(0, backoffIndex - 1), BACKOFF_DELAYS_MS.length - 1)];
                    h.postDelayed(retryBuild, delay);
                    retryScheduled = true;
                }
            }
        }
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
        h.removeCallbacks(trimComplete);
        Density.restoreIfActive(this);
        HomeKeyService.ensure(this);
        if (web == null && started && !retryScheduled && !retryPending) build();      // never leave a black screen (a trim between onStart and here)
        if (web != null) { web.view().onResume(); Timers.up(this, web.view()); }
        armStable();
        Eco.start(this);                       // the wallpaper is in front: the panel goes to the eco backlight
    }

    @Override protected void onPause() {
        resumed = false;
        pauseStable();
        Eco.stop(this);                         // an app, an input or sleep: the owner's backlight comes back
        // hidden, the page stops drawing and its timers slow (it ran at ~21% CPU behind YouTube, 3 Nov)
        if (web != null) { web.view().onPause(); Timers.down(this, web.view()); }   // and its scripts, if nothing of ours shows
        super.onPause();
    }

    @Override protected void onStop() {
        super.onStop();
        started = false;
        pauseStable();
        if (!isChangingConfigurations()) release("stopped");
    }

    @Override public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (!started && !resumed && level >= ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN) {
            release("trim " + level);
            if (level < ComponentCallbacks2.TRIM_MEMORY_COMPLETE && !started && Timers.noneShown()) {
                h.removeCallbacks(trimComplete);
                h.post(trimComplete);
            }
        }
    }

    private boolean isHome() {
        return getIntent() != null && getIntent().hasCategory("android.intent.category.HOME");
    }

    @Override public boolean dispatchKeyEvent(KeyEvent e) {
        if (Web.isNetworkSuppressed()) {
            Web.setSuppressNetwork(false);
            if (web != null) web.checkNow();
        }
        if (web != null && web.key(e)) return true;
        if (e.getKeyCode() == KeyEvent.KEYCODE_BACK && isHome()) return true;
        return super.dispatchKeyEvent(e);
    }

    @Override protected void onDestroy() {
        started = false;
        resumed = false;
        h.removeCallbacks(retryBuild);
        h.removeCallbacks(resetDeaths);
        h.removeCallbacks(trimComplete);
        retryScheduled = false;
        retryPending = false;
        release("destroyed");
        clearFallbackPoster();
        h.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
