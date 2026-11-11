package dev.designyourtv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.View;
import android.net.Uri;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.KeyEvent;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import dev.designyourtv.core.HubChooser;
import dev.designyourtv.core.WebHosts;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * A website as a TV app, driven by the remote: Claude (claude.ai's desktop site, since the Claude
 * Android app needs Android 12 and this TV runs 11) and the Dashboard (a skeleton on the hub for now).
 *
 * Desktop layout: the page zoom is set so claude.ai sees a 1440 CSS px wide desktop window on the 1920 x 1080 panel. The D-pad drives
 * assets/tvnav.js: arrows move a visible focus ring between controls (or scroll when there is none that way), OK
 * clicks, Back goes back a page and leaves from the first one. Main-frame navigation stays on the app's own hosts.
 */
public class WebApp extends Activity {
    static final String CLAUDE = "claude", DASHBOARD = "dashboard";
    private WebView view;
    private String nav = "";
    private String[] hosts;
    private boolean dashboard;
    private static final int DOT = 34;
    private View dot;
    private boolean pointerOn, autoPointer, handingHome;
    static final long MIN_IDLE_MS = 2 * 60 * 1000L, MAX_IDLE_MS = 5 * 60 * 1000L, LOOK_MS = 30_000L;
    private long idleMs = MIN_IDLE_MS;
    private int lastText = -1;
    private View splash;
    private final Handler idle = new Handler(Looper.getMainLooper());
    private final Runnable toHome = new Runnable() { @Override public void run() { home(); } };
    /** Every 30 s: has the page's text changed (Claude still writing)? Then it isn't idle, though no key was pressed. */
    private final Runnable look = new Runnable() { @Override public void run() {
        if (view == null) return;
        view.evaluateJavascript("document.body?document.body.innerText.length:0", new android.webkit.ValueCallback<String>() {
            @Override public void onReceiveValue(String v) {
                int n; try { n = Integer.parseInt(v); } catch (Exception e) { n = -1; }
                if (n != lastText && lastText >= 0) touched();
                lastText = n;
            }
        });
        idle.postDelayed(this, LOOK_MS);
    } };
    private float px, py;

    /** The one site screen alive: opening the other closes it, so two never hold memory at once. */
    static WebApp current;
    private static final java.util.List<Long> webAppDeathTimes = new java.util.ArrayList<>();

    private final Runnable resetDeaths = new Runnable() {
        @Override public void run() {
            webAppDeathTimes.clear();
            Log.w(Density.TAG, "webapp stable for 60s; death counter reset");
        }
    };

    @SuppressLint("SetJavaScriptEnabled")
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        if (current != null && current != this && !current.isFinishing()) current.finish();
        current = this;
        // A second site needs its own activity in its own task: one singleTask activity for two sites comes back as
        // whichever it showed first, since Android brings a task forward unchanged when the start matches its first
        // intent, and extras don't count.
        String app = CLAUDE;                       // the only site this screen opens in the public build
        String url = app.equals(DASHBOARD) ? HubChooser.HUB + "/tv-dashboard.html" : "https://claude.ai/code";
        hosts = app.equals(DASHBOARD) ? new String[] { Uri.parse(HubChooser.HUB).getHost() }
            : new String[] { "claude.ai", "claude.com", "anthropic.com" };
        dashboard = app.equals(DASHBOARD);
        nav = asset("tvnav.js");

        DisplayMetrics dm = getResources().getDisplayMetrics();
        WebView.setWebContentsDebuggingEnabled(true);        // inspect the live page over adb only, as Web.java does
        view = new QuietWebView(this);
        view.setVerticalScrollBarEnabled(false);              // the page scrolls; the bar only flashed at the edge
        view.setHorizontalScrollBarEnabled(false);
        view.setBackgroundColor(app.equals(CLAUDE) ? 0xFF262624 : Color.BLACK);
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        // a desktop browser's name, so the site serves its desktop page (the TV build of Chrome reports "Android")
        String ua = s.getUserAgentString();
        String chrome = ua.replaceAll(".*(Chrome/[\\d.]+).*", "$1");
        if (app.equals(CLAUDE)) s.setUserAgentString("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " + chrome + " Safari/537.36");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);
        if (android.os.Build.VERSION.SDK_INT >= 26) view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true);
        view.setWebChromeClient(new WebChromeClient());
        view.setWebViewClient(new WebViewClient() {
            @Override public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail d) {
                idle.removeCallbacks(resetDeaths);
                Log.w(Density.TAG, "webapp renderer gone (" + (android.os.Build.VERSION.SDK_INT >= 26 && d.didCrash() ? "crashed" : "killed") + ")");
                if (view != null) {
                    android.view.ViewParent p = view.getParent();
                    if (p instanceof android.view.ViewGroup) ((android.view.ViewGroup) p).removeView(view);
                    view.stopLoading();
                    view.destroy();
                    view = null;
                }
                if (isFinishing()) return true;
                long now = android.os.SystemClock.elapsedRealtime();
                for (int i = webAppDeathTimes.size() - 1; i >= 0; i--) {
                    if (now - webAppDeathTimes.get(i) > 60000) webAppDeathTimes.remove(i);
                }
                webAppDeathTimes.add(now);
                if (webAppDeathTimes.size() >= 2) {
                    Log.w(Density.TAG, "webapp renderer died repeatedly; finishing");
                    finish();
                    return true;
                }
                recreate();
                return true;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return !r.isForMainFrame() ? false : !allowed(r.getUrl()); }
            @SuppressWarnings("deprecation")
            @Override public boolean shouldOverrideUrlLoading(WebView v, String u) { return !allowed(Uri.parse(u)); }
            @Override public void onPageCommitVisible(WebView v, String u) { reveal(); }
            @Override public void onPageFinished(WebView v, String u) {
                idle.removeCallbacks(resetDeaths);
                idle.postDelayed(resetDeaths, 60000);
                reveal();
                if (!nav.isEmpty()) v.evaluateJavascript(nav, null);
                // a "verify you are human" page: its tick box sits in a frame the focus ring can't reach, so the
                // pointer comes up for the viewer to move onto it and press OK
                String t = v.getTitle();
                if (t != null && t.startsWith("Just a moment")) { autoPointer = true; pointer(true); }
                else if (autoPointer) { autoPointer = false; pointer(false); }
            }
        });

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        // The desktop layout comes from the page zoom, not from drawing a bigger view and shrinking it: the shrink drew
        // 2880 x 1620 pixels for a 1920 x 1080 panel and the Claude screen ran at 130% CPU (3 Nov evening).
        // Initial scale is in percent of physical pixels: 1920 px at 133% = 1440 CSS px wide, whatever the density.
        root.addView(view, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        if (!dashboard) {
            s.setUseWideViewPort(false);
            s.setLoadWithOverviewMode(false);
            view.setInitialScale(Math.round(dm.widthPixels * 100f / 1440));
        }
        // Until the first frame of the page is ready: Claude's mark on Claude's own background, not a white flash and
        // half-built layout
        if (!dashboard) {
            FrameLayout sp = new FrameLayout(this);
            sp.setBackgroundColor(0xFF262624);
            android.widget.ImageView mark = new android.widget.ImageView(this);
            mark.setImageResource(R.drawable.icon_claude);
            int side = Math.round(dm.heightPixels * 0.11f);
            sp.addView(mark, new FrameLayout.LayoutParams(side, side, android.view.Gravity.CENTER));
            root.addView(sp, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
            splash = sp;
            idle.postDelayed(new Runnable() { @Override public void run() { reveal(); } }, 8000);   // never stuck behind it
        }
        GradientDrawable ring = new GradientDrawable();
        ring.setShape(GradientDrawable.OVAL);
        ring.setColor(0x66D97757);
        ring.setStroke(4, Color.WHITE);
        dot = new View(this);
        dot.setBackground(ring);
        dot.setVisibility(View.GONE);
        root.addView(dot, new FrameLayout.LayoutParams(DOT, DOT));
        px = dm.widthPixels / 2f; py = dm.heightPixels / 2f;
        setContentView(root);
        view.setFocusable(true);
        view.requestFocus();
        view.loadUrl(url);
    }

    private void reveal() {
        final View sp = splash;
        if (sp == null) return;
        splash = null;
        sp.animate().alpha(0f).setDuration(220).withEndAction(new Runnable() { @Override public void run() { ((FrameLayout) sp.getParent()).removeView(sp); } }).start();
    }

    private boolean allowed(Uri u) {
        if (u == null) return false;
        if (WebHosts.allowed(u.getScheme(), u.getHost(), hosts, dashboard)) return true;
        Log.w(Density.TAG, "kept off-site: " + u);
        return false;
    }

    private String asset(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            byte[] buf = new byte[8192]; int n;
            while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
            return o.toString("UTF-8");
        } catch (Exception e) { Log.w(Density.TAG, "no " + name, e); return ""; }
    }

    /** The pointer: a dot the arrows move and OK taps, for anything the focus ring can't reach (a frame, a hover menu).
     *  Menu turns it on and off; Back turns it off. */
    private void pointer(boolean on) {
        pointerOn = on;
        if (dot == null) return;
        dot.setVisibility(on ? View.VISIBLE : View.GONE);
        place();
    }

    private void place() {
        DisplayMetrics dm = getResources().getDisplayMetrics();
        px = Math.max(0, Math.min(dm.widthPixels - 1, px));
        py = Math.max(0, Math.min(dm.heightPixels - 1, py));
        dot.setTranslationX(px - DOT / 2f);
        dot.setTranslationY(py - DOT / 2f);
    }

    private void tap() {
        long t = SystemClock.uptimeMillis();
        float x = px, y = py;                                  // the WebView fills the screen at its own pixels
        MotionEvent down = MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, x, y, 0);
        MotionEvent up = MotionEvent.obtain(t, t + 60, MotionEvent.ACTION_UP, x, y, 0);
        down.setSource(InputDevice.SOURCE_TOUCHSCREEN); up.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        if (view != null) { view.dispatchTouchEvent(down); view.dispatchTouchEvent(up); }
        down.recycle(); up.recycle();
    }

    private boolean pointerKey(KeyEvent e) {
        int k = e.getKeyCode();
        if (k == KeyEvent.KEYCODE_MENU) { if (e.getAction() == KeyEvent.ACTION_UP) pointer(!pointerOn); return true; }
        if (!pointerOn) return false;
        if (k == KeyEvent.KEYCODE_BACK) { if (e.getAction() == KeyEvent.ACTION_UP) pointer(false); return true; }
        int step = 24 + 12 * Math.min(e.getRepeatCount(), 8);   // held down, it speeds up
        boolean down = e.getAction() == KeyEvent.ACTION_DOWN;
        switch (k) {
            case KeyEvent.KEYCODE_DPAD_LEFT:  if (down) { px -= step; place(); } return true;
            case KeyEvent.KEYCODE_DPAD_RIGHT: if (down) { px += step; place(); } return true;
            case KeyEvent.KEYCODE_DPAD_UP:    if (down) { py -= step; place(); } return true;
            case KeyEvent.KEYCODE_DPAD_DOWN:  if (down) { py += step; place(); } return true;
            case KeyEvent.KEYCODE_DPAD_CENTER: case KeyEvent.KEYCODE_ENTER:
                if (e.getAction() == KeyEvent.ACTION_UP) tap(); return true;
            default: return false;
        }
    }

    @Override public boolean dispatchKeyEvent(KeyEvent e) {
        Eco.poke();
        touched();
        if (view != null && pointerKey(e)) return true;
        if (e.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (e.getAction() == KeyEvent.ACTION_UP && view != null) {
                // an open menu or dialog closes first; then back a page; then out
                view.evaluateJavascript("window.__tvnavBack ? window.__tvnavBack() : false", new android.webkit.ValueCallback<String>() {
                    @Override public void onReceiveValue(String closed) {
                        if ("true".equals(closed) || view == null) return;
                        if (view.canGoBack()) view.goBack(); else finish();
                    }
                });
            } else if (e.getAction() == KeyEvent.ACTION_UP) {
                finish();
            }
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    /** Left alone, the screen hands back to the wallpaper: a page playing video (claude.ai's sign-in page does) keeps
     *  the TV awake, so the system's own idle timer never starts the wallpaper by itself (seen 3 Nov: 1 h 38 min). */
    private void home() {
        // Only from our own screen while it is really the one in front: if something else (a system dialog, another app's
        // window) has taken the focus, wait and look again rather than pulling the wallpaper over it (S5 step 1, 6 Nov).
        if (!hasWindowFocus()) { touched(); return; }
        handingHome = true;
        try { startActivity(new Intent(this, HomeActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
        catch (Exception e) { Log.w(Density.TAG, "could not open the wallpaper", e); handingHome = false; }
        finish();
    }

    /** The hand-back follows the TV's own screen-off delay, kept between 2 and 5 minutes (it is "never" now). */
    private void touched() { idle.removeCallbacks(toHome); idle.postDelayed(toHome, idleMs); }

    @Override protected void onResume() {
        super.onResume();
        handingHome = false;
        if (view != null) { view.onResume(); Timers.up(this, view); }
        Eco.start(this, Eco.READING);           // a reading screen: 70, not his full level (video apps keep 100)
        // Bounded both ways: the system timeout is now "never" (6 Nov, so the TV cannot sleep on its own), which would
        // otherwise mean this screen never hands back to the wallpaper.
        try { idleMs = Math.min(MAX_IDLE_MS, Math.max(MIN_IDLE_MS, android.provider.Settings.System.getLong(getContentResolver(), android.provider.Settings.System.SCREEN_OFF_TIMEOUT))); }
        catch (Exception e) { idleMs = MIN_IDLE_MS; }
        touched();
        idle.removeCallbacks(look); lastText = -1; idle.postDelayed(look, LOOK_MS);
    }

    @Override protected void onPause() {
        idle.removeCallbacks(toHome); idle.removeCallbacks(look); idle.removeCallbacks(resetDeaths);
        CookieManager.getInstance().flush();
        if (view != null) { view.onPause(); Timers.down(this, view); }
        if (!handingHome) Eco.stop(this);       // going to the wallpaper keeps the dim; anything else gets his level
        super.onPause();
    }

    /** Out of sight, the screen closes: WebView.onPause doesn't stop a page's scripts, and claude.ai went on
     *  running behind the wallpaper and every app (4 Nov, a CPU profile of the TV). The next open loads afresh. */
    @Override protected void onStop() {
        super.onStop();
        if (!isChangingConfigurations() && !isFinishing()) finish();
    }

    @Override public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (level >= TRIM_MEMORY_UI_HIDDEN && !isFinishing()) finish();
    }

    @Override protected void onDestroy() {
        idle.removeCallbacks(resetDeaths);
        if (view != null) {
            android.view.ViewParent p = view.getParent();
            if (p instanceof android.view.ViewGroup) ((android.view.ViewGroup) p).removeView(view);
            view.stopLoading();
            view.destroy();
            view = null;
        }
        if (current == this) current = null;
        super.onDestroy();
    }
}
