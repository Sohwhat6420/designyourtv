package dev.designyourtv;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.Matrix;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;

import dev.designyourtv.core.HubChooser;
import dev.designyourtv.core.IntentPolicy;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Calendar;

/** The WebView shared by the screensaver and the home page: the hub's page, or the built-in copy when the desk laptop is off. */
final class Web {
    /** launched: the page opened an app. gone: the page's renderer died (killed for memory, or crashed); the view is
     *  dead and the host drops or rebuilds it. */
    interface Host {
        void launched();
        void gone();
        default void gone(boolean didCrash) { gone(); }
        default void ready() {}
    }

    private final WebView view;
    private final FrameLayout root;
    /** The last painting, shown at once while the page starts (it took ~7.5 s to appear, through black and grey,
     *  measured 3 Nov); the page says ready() and it fades away. */
    private final ImageView poster;
    private Bitmap posterBitmap;
    private boolean posterLoading;
    private boolean ready;
    private boolean rendererDead;
    private static final String POSTER = "poster.img", POSTER_PREFS = "poster", STATE_PREFS = "page-state";
    private static final long POSTER_MAX_MS = 15000;         // the page never said ready: let it show anyway
    private final Handler h = new Handler(Looper.getMainLooper());
    private final Context ctx;
    private final Host host;
    private String showing = null;                       // the origin the page came from, or "offline" for the built-in copy
    private volatile boolean alive = true;
    /** When this view was made: the log says how long the poster and the page took (the Home -> wallpaper times). */
    private final long born = android.os.SystemClock.elapsedRealtime();
    private volatile boolean drawerOpen = false;          // the page says its All apps drawer is up (Back closes it)
    /** The TV's own now playing goes to the page as it changes (window.tvNowPlaying); NowPlaying.java says how. */
    private final NowPlaying.Sink np = new NowPlaying.Sink() {
        @Override public void nowPlaying(final String json) {
            h.post(new Runnable() { @Override public void run() {
                if (alive) view.evaluateJavascript("window.tvNowPlaying&&tvNowPlaying(" + json + ")", null);
            } });
        }
    };

    @SuppressLint("SetJavaScriptEnabled")
    Web(Context c, final Host host) {
        ctx = c;
        this.host = host;
        WebView.setWebContentsDebuggingEnabled(true);        // inspect the live page over adb only (localabstract socket)
        view = new QuietWebView(c);
        view.setBackgroundColor(Color.BLACK);
        // no hardware layer: it made every WebView frame render off-screen and then be copied, an extra full-screen
        // pass on the TV's Mali-G52 (4 Nov: dock frames p50 ~50 ms, 31 ms of it issuing draw commands)
        view.setLayerType(View.LAYER_TYPE_NONE, null);
        // no scrollbars: the vertical one faded in at the right edge on every key (4 Nov, "for every interaction")
        view.setVerticalScrollBarEnabled(false);
        view.setHorizontalScrollBarEnabled(false);
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);                         // our own assets only (see mayLoad)
        s.setAllowContentAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " DesignYourTV/1.0");
        view.addJavascriptInterface(new Bridge(), "DesignYourTV");
        NowPlaying.add(np);   // only the hub page and our offline copy load (HubChooser.mayLoad)
        // Out of sight, the renderer is waived to oom_score_adj 900; while visible, it stays important (RENDERER_PRIORITY_IMPORTANT)
        if (android.os.Build.VERSION.SDK_INT >= 26) view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true);
        view.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView v, String url, Bitmap icon) { drawerOpen = false; }
            // without this, a renderer killed for memory takes our whole process with it (and the Home button service)
            @Override public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail d) {
                boolean crashed = android.os.Build.VERSION.SDK_INT >= 26 && d.didCrash();
                Log.w(Density.TAG, "page renderer gone (" + (crashed ? "crashed" : "killed") + ")");
                rendererDead = true;
                if (crashed) {
                    clearLastOrigin();
                    setSuppressNetwork(true);
                }
                if (alive) { alive = false; host.gone(crashed); }
                return true;
            }
            @Override public void onPageFinished(WebView v, String url) {
                if (HubChooser.OFFLINE.equals(url) && !ready) {
                    onReady();
                }
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, android.webkit.WebResourceError error) {
                if (r != null && r.isForMainFrame()) {
                    Log.w(Density.TAG, "main frame error; resetting sticky origin");
                    sticky.reset();
                    checkNow();
                }
            }
            @SuppressWarnings("deprecation")
            @Override public void onReceivedError(WebView v, int errorCode, String description, String failingUrl) {
                Log.w(Density.TAG, "main frame error " + errorCode + "; resetting sticky origin");
                sticky.reset();
                checkNow();
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return handle(r.getUrl().toString(), host); }
            @SuppressWarnings("deprecation")
            @Override public boolean shouldOverrideUrlLoading(WebView v, String url) { return handle(url, host); }
        });
        view.setFocusable(true);
        view.setFocusableInTouchMode(true);
        root = new FrameLayout(c);
        root.setBackgroundColor(Color.BLACK);
        root.addView(view, new FrameLayout.LayoutParams(-1, -1));
        poster = new ImageView(c);
        poster.setScaleType(ImageView.ScaleType.MATRIX);
        poster.setFocusable(false);
        poster.setVisibility(View.GONE);
        root.addView(poster, new FrameLayout.LayoutParams(-1, -1));
    }

    WebView view() { return view; }

    /** What the activity or screensaver shows: the page with the poster over it. */
    View root() { return root; }

    /** Put the last painting over the page until it says ready(). Decoded off the main thread. */
    /** The page's night hours (tv-setup.html NIGHT: 23:30 to 07:00) and its night look,
     *  filter: brightness(.22) saturate(.6), so a night launch doesn't flash the painting at full brightness. */
    private static boolean nightNow() {
        Calendar c = Calendar.getInstance();
        int t = c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE);
        return t >= 23 * 60 + 30 || t < 7 * 60;
    }
    private static final ColorMatrixColorFilter NIGHT_FILTER;
    static {
        ColorMatrix m = new ColorMatrix();
        m.setSaturation(.6f);                                  // the same luminance weights as CSS saturate()
        ColorMatrix dim = new ColorMatrix();
        dim.setScale(.22f, .22f, .22f, 1f);
        m.postConcat(dim);
        NIGHT_FILTER = new ColorMatrixColorFilter(m);
    }

    private void freePoster() {
        poster.animate().cancel();
        poster.setVisibility(View.GONE);
        poster.setImageDrawable(null);
        if (posterBitmap != null) {
            posterBitmap.recycle();
            posterBitmap = null;
        }
    }

    private void cover() {
        if (!alive || ready) return;
        if (poster.getVisibility() == View.VISIBLE) {
            h.removeCallbacks(uncover);
            h.postDelayed(uncover, POSTER_MAX_MS);
            return;
        }
        if (posterLoading) return;
        final File f = new File(ctx.getFilesDir(), POSTER);
        if (!f.isFile()) return;
        posterLoading = true;
        final float fx = ctx.getSharedPreferences(POSTER_PREFS, 0).getFloat("fx", .5f);
        final float fy = ctx.getSharedPreferences(POSTER_PREFS, 0).getFloat("fy", .5f);
        new Thread(new Runnable() { @Override public void run() {
            Bitmap decoded = null;
            try {
                BitmapFactory.Options o = new BitmapFactory.Options();
                o.inJustDecodeBounds = true;
                BitmapFactory.decodeFile(f.getPath(), o);
                o.inSampleSize = o.outWidth > 3000 ? 2 : 1;      // the panel is 1920 wide
                o.inJustDecodeBounds = false;
                o.inPreferredConfig = Bitmap.Config.RGB_565;     // half the memory; it is on screen for seconds
                decoded = BitmapFactory.decodeFile(f.getPath(), o);
            } catch (Throwable t) {
                Log.w(Density.TAG, "poster decode failed: " + t);
            }
            final Bitmap bm = decoded;
            h.post(new Runnable() { @Override public void run() {
                posterLoading = false;
                if (bm == null) return;
                if (!alive || ready) { bm.recycle(); return; }
                if (posterBitmap != null && posterBitmap != bm) { poster.setImageDrawable(null); posterBitmap.recycle(); }
                posterBitmap = bm;
                poster.setImageBitmap(bm);
                poster.setColorFilter(nightNow() ? NIGHT_FILTER : null);   // the page dims its plate at night: match it
                place(bm, fx, fy);
                poster.animate().cancel();
                poster.setAlpha(0f);
                poster.setVisibility(View.VISIBLE);
                poster.animate().alpha(1f).setDuration(150).start();   // out of black, not a cut
                Log.w(Density.TAG, "poster up " + (android.os.SystemClock.elapsedRealtime() - born) + " ms after the view was made");
                h.removeCallbacks(uncover);
                h.postDelayed(uncover, POSTER_MAX_MS);
            } });
        } }, "poster").start();
    }

    /** object-fit: cover with object-position fx, fy, as the page draws its plate. */
    private void place(Bitmap bm, float fx, float fy) {
        int vw = root.getWidth(), vh = root.getHeight();
        if (vw == 0 || vh == 0) { vw = ctx.getResources().getDisplayMetrics().widthPixels; vh = ctx.getResources().getDisplayMetrics().heightPixels; }
        float sc = Math.max(vw / (float) bm.getWidth(), vh / (float) bm.getHeight());
        Matrix m = new Matrix();
        m.setScale(sc, sc);
        m.postTranslate((vw - bm.getWidth() * sc) * fx, (vh - bm.getHeight() * sc) * fy);
        poster.setImageMatrix(m);
    }

    private final Runnable uncover = new Runnable() { @Override public void run() {
        h.removeCallbacks(this);
        if (poster.getVisibility() != View.VISIBLE) { freePoster(); return; }
        poster.animate().alpha(0f).setDuration(400).withEndAction(new Runnable() { @Override public void run() {
            freePoster();                                        // the bitmap goes back at once: this TV has 1.8 GB
        } }).start();
    } };

    /** Keep the painting the page is showing, for the next start. Only the hub's own images, at most 6 MB. */
    private void savePoster(final String url, final float fx, final float fy) {
        if (!HubChooser.ours(url)) return;
        final android.content.SharedPreferences p = ctx.getSharedPreferences(POSTER_PREFS, 0);
        if (url.equals(p.getString("url", null)) && p.getFloat("fx", -1) == fx && p.getFloat("fy", -1) == fy) return;
        new Thread(new Runnable() { @Override public void run() {
            HttpURLConnection c = null;
            File tmp = new File(ctx.getFilesDir(), POSTER + ".part");
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(HubChooser.TIMEOUT_MS);
                c.setReadTimeout(10000);
                if (c.getResponseCode() != 200) return;
                InputStream in = c.getInputStream();
                FileOutputStream out = new FileOutputStream(tmp);
                boolean whole = true;
                try {
                    byte[] buf = new byte[16384]; int n, total = 0;
                    while ((n = in.read(buf)) > 0) {
                        total += n;
                        if (total > (6 << 20)) { whole = false; break; }
                        out.write(buf, 0, n);
                    }
                } finally { out.close(); in.close(); }
                if (whole && tmp.renameTo(new File(ctx.getFilesDir(), POSTER)))
                    p.edit().putString("url", url).putFloat("fx", fx).putFloat("fy", fy).apply();
            } catch (Exception e) {
                Log.w(Density.TAG, "poster not saved: " + e);
            } finally {
                if (c != null) c.disconnect();
                tmp.delete();
            }
        } }, "poster-save").start();
    }

    /** What the page may ask of the TV: the launchable apps for the drawer, and whether the drawer is up. */
    final class Bridge {
        @JavascriptInterface public String apps() { return Apps.json(ctx); }
        @JavascriptInterface public void drawer(boolean open) { drawerOpen = open; }
        /** Night mode on the wallpaper (OK dims the panel right down, widgets stay live): 1-35 holds
         *  that backlight, anything else lets go. */
        @JavascriptInterface public void night(int level) { Eco.night(level); }
        @JavascriptInterface public String nowPlaying() { return NowPlaying.latest(); }
        /** The dock's screen-off button: the panel goes pitch black now and the next remote key brings it back (Eco.darken,
         *  Web.key). The app stays in front, so adb stays reachable. @return false when the backlight write was refused. */
        @JavascriptInterface public boolean screenOff() {
            if (!Eco.darken(ctx)) return false;
            h.post(new Runnable() { @Override public void run() { view.evaluateJavascript("window.tvDark&&tvDark(true)", null); } });
            return true;
        }
        /** The TV's physical inputs, as JSON, read when the sidebar opens (Inputs.json). */
        @JavascriptInterface public String inputs() { return Inputs.json(ctx); }
        /** Opens one of the inputs inputs() listed. */
        @JavascriptInterface public boolean openInput(String id) { return Inputs.open(ctx, id); }
        /** The page's own saved state, kept by the app so it is the same whichever origin the page came from (the hub
         *  and the POCO each have their own localStorage: 4 Nov, the painting jumped when the origin changed).
         *  null when the key was never set. */
        @JavascriptInterface public String get(String k) { return k == null ? null : ctx.getSharedPreferences(STATE_PREFS, 0).getString(k, null); }
        /** v null removes the key. Keys and values are capped (64 chars, 64 KB) so a page can't fill /data. */
        @JavascriptInterface public void set(String k, String v) {
            if (k == null || k.length() > 64 || (v != null && v.length() > 65536)) return;
            android.content.SharedPreferences.Editor e = ctx.getSharedPreferences(STATE_PREFS, 0).edit();
            (v == null ? e.remove(k) : e.putString(k, v)).apply();
        }
        /** The painting now showing, kept as the next start's poster (fx, fy: its CSS object-position, 0-1). */
        @JavascriptInterface public void poster(String url) { savePoster(url, .5f, .5f); }
        @JavascriptInterface public void poster(String url, float fx, float fy) {
            savePoster(url, Math.max(0f, Math.min(1f, fx)), Math.max(0f, Math.min(1f, fy)));
        }
        /** The page has revealed itself: the poster fades away. */
        @JavascriptInterface public void ready() {
            onReady();
        }
    }

    void onReady() {
        h.post(new Runnable() { @Override public void run() {
            if (!ready) Log.w(Density.TAG, "page ready " + (android.os.SystemClock.elapsedRealtime() - born) + " ms after the view was made (" + showing + ")");
            ready = true; uncover.run();
            if (alive) host.ready();
        } });
    }

    /** Keys the WebView never sees or Xiaomi keeps: CH+ and CH- change the painting (his remote has no fast-forward),
     *  and Back closes the drawer first. @return true when handled here. */
    boolean key(KeyEvent e) {
        if (suppressNetwork) {
            suppressNetwork = false;
            checkNow();
        }
        if (Eco.isDark()) {                     // the screen-off button: any remote key wakes it, and that key does nothing else
            if (e.getAction() == KeyEvent.ACTION_DOWN && e.getRepeatCount() == 0) {
                Eco.light();
                view.evaluateJavascript("window.tvDark&&tvDark(false)", null);
            }
            return true;
        }
        Eco.poke();
        int k = e.getKeyCode();
        if (k == KeyEvent.KEYCODE_CHANNEL_UP || k == KeyEvent.KEYCODE_CHANNEL_DOWN) {
            if (e.getAction() == KeyEvent.ACTION_DOWN && e.getRepeatCount() == 0)
                view.evaluateJavascript("window.tvTurn&&tvTurn(" + (k == KeyEvent.KEYCODE_CHANNEL_UP ? 1 : -1) + ")", null);
            return true;
        }
        if (k == KeyEvent.KEYCODE_BACK && drawerOpen) {
            if (e.getAction() == KeyEvent.ACTION_UP) view.evaluateJavascript("window.tvBack&&tvBack()", null);
            return true;
        }
        return false;
    }

    private boolean handle(String url, Host host) {
        if (url.startsWith("intent:")) {
            IntentPolicy.Target t = IntentPolicy.parse(url, Apps.listed());
            if (t == null) { Log.w(Density.TAG, "dropped link " + url); return true; }
            try {
                Intent i;
                if (t.pkg != null) {
                    PackageManager pm = ctx.getPackageManager();
                    // TV apps answer LEANBACK_LAUNCHER, phone apps LAUNCHER: the page only asks for the second
                    i = pm.getLeanbackLaunchIntentForPackage(t.pkg);
                    if (i == null) i = pm.getLaunchIntentForPackage(t.pkg);
                    if (i == null) { Log.w(Density.TAG, t.pkg + " is not installed"); return true; }
                    if (t.pkg.equals("com.anthropic.claude")) i = new Intent(ctx, ClaudeTile.class);   // Claude goes through the tile
                } else if (t.action.equals(IntentPolicy.OPEN_CLAUDE)) {
                    i = new Intent(ctx, ClaudeTile.class);
                } else {
                    i = new Intent(t.action);
                }
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                host.launched();
            } catch (Exception e) { Log.w(Density.TAG, "could not open " + url, e); }
            return true;
        }
        return !HubChooser.mayLoad(url);                    // false = let the WebView load it
    }

    /** Load the hub page if the hub answers within 4 s, else the POCO's mirror of it, else the built-in copy; re-check
     *  every minute. */
    void start() {
        // a page rebuilt after onStop loads at once from the origin that last worked, not after a health check (up to
        // 4 s per origin); sticky is seeded with it so a single missed probe does not reload, and the first check confirms
        ready = false;
        cover();
        String last = lastOrigin;
        if (last != null) {
            showing = last;
            sticky.seed(last);
            view.loadUrl(HubChooser.pageFrom(last) + "&boot=" + bootCount());
        } else {
            showing = "offline";
            view.loadUrl(HubChooser.OFFLINE);
        }
        check(); Apps.warm(ctx);
    }

    /** The origin the last page came from (null: none yet, or the built-in copy). */
    private static volatile String lastOrigin;
    static void clearLastOrigin() { lastOrigin = null; }

    private static volatile boolean suppressNetwork = false;
    static void setSuppressNetwork(boolean suppress) { suppressNetwork = suppress; }
    static boolean isNetworkSuppressed() { return suppressNetwork; }

    private final Runnable checkRunnable = new Runnable() { @Override public void run() { check(); } };
    private volatile boolean checking;

    void checkNow() {
        h.removeCallbacks(checkRunnable);
        check();
    }

    private void check() {
        if (!alive || checking) return;
        if (suppressNetwork) {
            Log.w(Density.TAG, "network origin check suppressed after renderer crash");
            return;
        }
        checking = true;
        // anonymous classes, not lambdas: the SDK's stub android.jar has no LambdaMetafactory to compile them against
        new Thread(new Runnable() { @Override public void run() {
            final String best = firstUp();
            h.post(new Runnable() { @Override public void run() {
                checking = false;
                if (!alive || suppressNetwork) return;
                final String origin = sticky.next(best);
                if (!eq(best, origin)) Log.w(Density.TAG, "page source: " + best + " answered, staying on " + origin);
                String now = origin == null ? "offline" : origin;
                if (!now.equals(showing)) {
                    if (showing != null) Log.w(Density.TAG, "page source: " + showing + " -> " + now);
                    showing = now; ready = false; cover();
                    lastOrigin = origin;
                    view.loadUrl(HubChooser.pageFrom(origin) + (origin != null ? "&boot=" + bootCount() : ""));
                }
                h.removeCallbacks(checkRunnable);
                h.postDelayed(checkRunnable, sticky.pending() ? HubChooser.PENDING_RECHECK_MS : HubChooser.RECHECK_MS);
            } });
        } }, "hub-check").start();
    }

    private final HubChooser.Sticky sticky = new HubChooser.Sticky();
    private static boolean eq(String a, String b) { return a == null ? b == null : a.equals(b); }

    /** The page's rotation restarts on ?start= only when this changes, i.e. after a restart (not when Android kills
     *  and reopens the page after a show). Boot count, not boot time: the clock jumps when NTP syncs after boot. */
    private String bootCount() {
        return String.valueOf(Settings.Global.getInt(ctx.getContentResolver(), Settings.Global.BOOT_COUNT, 0));
    }

    /** The first of the hub and the POCO's mirror whose /api/health answers ok, or null. */
    static String firstUp() {
        for (String o : HubChooser.ORIGINS) if (up(o)) return o;
        return null;
    }

    private static boolean up(String origin) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(origin + "/api/health").openConnection();
            c.setConnectTimeout(HubChooser.TIMEOUT_MS);
            c.setReadTimeout(HubChooser.TIMEOUT_MS);
            int code = c.getResponseCode();
            InputStream in = code == 200 ? c.getInputStream() : null;
            String body = null;
            if (in != null) {
                ByteArrayOutputStream o = new ByteArrayOutputStream();
                byte[] buf = new byte[4096]; int n;
                while ((n = in.read(buf)) > 0 && o.size() < 65536) o.write(buf, 0, n);
                body = o.toString("UTF-8");
            }
            return HubChooser.healthy(code, body);
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    void destroy() {
        alive = false;
        NowPlaying.remove(np);
        h.removeCallbacksAndMessages(null);
        freePoster();                                        // the poster bitmap, if the page never said ready
        root.removeAllViews();                               // detach WebView from its parent before destroy()
        view.stopLoading();
        if (!rendererDead && Timers.noneShown() && WebApp.current == null) view.clearCache(false);      // drop RAM resource cache (keep disk HTTP cache)
        view.destroy();
    }
}
