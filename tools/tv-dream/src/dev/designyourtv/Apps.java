package dev.designyourtv;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.AdaptiveIconDrawable;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.os.SystemClock;
import android.util.Base64;

import dev.designyourtv.core.IntentPolicy;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Every launchable app on the TV, for the page's round-icon drawer: label, package and icon. */
final class Apps {
    private static final int SIZE = 192;                       // px: a 6 cqw circle at 1080p is ~115 px, the dock's ~150
    private static final long FRESH_MS = 10 * 60_000L;
    private static String json;
    private static long at;
    private static final Set<String> listed = new HashSet<>();

    private Apps() {}

    /** The packages the drawer last listed: only these (and the dock's own) may be opened from it. */
    static synchronized Set<String> listed() { return new HashSet<>(listed); }

    /** The list as last built, at once: drawing every icon takes the TV ~1 s (measured 4 Nov: 973 ms), which the page's
     *  drawer used to wait for whenever the copy was over 10 minutes old. A stale copy is answered and rebuilt behind;
     *  only the very first call builds in line, and Web.start() makes that call early, off the main thread. */
    static String json(Context c) {
        synchronized (Apps.class) {
            if (json != null) {
                if (SystemClock.elapsedRealtime() - at >= FRESH_MS) refreshLater(c);
                return json;
            }
        }
        return build(c);
    }

    private static boolean refreshing;

    /** Build the first list behind, so the page's first drawer never waits for it. */
    static void warm(Context c) {
        synchronized (Apps.class) { if (json != null) return; }
        refreshLater(c);
    }

    /** Rebuild the list on a thread of its own (at start, and when the copy is stale). */
    static void refreshLater(final Context c) {
        synchronized (Apps.class) { if (refreshing) return; refreshing = true; }
        new Thread(new Runnable() { @Override public void run() {
            try { build(c.getApplicationContext()); }
            catch (Exception ignored) { }
            finally { synchronized (Apps.class) { refreshing = false; } }
        } }, "apps-list").start();
    }

    // not synchronized: a rebuild behind held the class lock for its whole ~1 s, so the drawer's call that found the
    // copy stale waited on it anyway (653 ms on the TV, 4 Nov); only the swap below is under the lock
    private static String build(Context c) {
        PackageManager pm = c.getPackageManager();
        Map<String, ResolveInfo> by = new LinkedHashMap<>();
        for (String cat : new String[] { Intent.CATEGORY_LEANBACK_LAUNCHER, Intent.CATEGORY_LAUNCHER }) {   // TV entry first
            Intent i = new Intent(Intent.ACTION_MAIN).addCategory(cat);
            for (ResolveInfo r : pm.queryIntentActivities(i, 0)) {
                String p = r.activityInfo.packageName;
                if (p.equals(c.getPackageName())) {
                    // our own screens are listed by what opens them (IntentPolicy's actions), not by package
                    String n = r.activityInfo.name;
                    if (n.endsWith(".ClaudeTile")) p = "intent: " + IntentPolicy.OPEN_CLAUDE;
                    else if (n.endsWith(".DashboardTile")) p = "intent: " + IntentPolicy.OPEN_DASHBOARD;
                    else continue;                                       // the Wallpaper tile: that is where the drawer lives
                }
                if (by.containsKey(p)) continue;
                by.put(p, r);
            }
        }
        List<Object[]> rows = new ArrayList<>();
        for (Map.Entry<String, ResolveInfo> e : by.entrySet()) rows.add(new Object[] { String.valueOf(e.getValue().loadLabel(pm)), e.getKey(), e.getValue() });
        Collections.sort(rows, new Comparator<Object[]>() { @Override public int compare(Object[] a, Object[] b) { return ((String) a[0]).compareToIgnoreCase((String) b[0]); } });
        JSONArray out = new JSONArray();
        Set<String> pk = new HashSet<>();
        for (Object[] r : rows) {
            Bitmap b = null;
            try {
                Drawable d = ((ResolveInfo) r[2]).loadIcon(pm);
                b = render(d);
                String shape = shape(b, d);
                JSONObject o = new JSONObject();
                o.put("label", r[0]); o.put("pkg", r[1]); o.put("shape", shape); o.put("full", !shape.equals("shaped")); o.put("icon", encode(b));
                out.put(o); if (!((String) r[1]).startsWith("intent: ")) pk.add((String) r[1]);
            } catch (Exception ignored) {
            } finally {
                if (b != null) b.recycle();
            }
        }
        String s = out.toString();
        synchronized (Apps.class) { listed.clear(); listed.addAll(pk); json = s; at = SystemClock.elapsedRealtime(); }
        return s;
    }

    /** An adaptive icon is drawn without the launcher's mask: both layers full bleed, cropped to the 72 of 108 dp a
     *  launcher shows, so the page cuts its own clean circle. Any other icon is drawn as the app made it. */
    private static Bitmap render(Drawable d) {
        Bitmap b = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(b);
        if (Build.VERSION.SDK_INT >= 26 && d instanceof AdaptiveIconDrawable) {
            AdaptiveIconDrawable a = (AdaptiveIconDrawable) d;
            int in = SIZE / 4;                                   // 108 dp drawn over 1.5x: the middle 72 dp fill the square
            for (Drawable layer : new Drawable[] { a.getBackground(), a.getForeground() }) {
                if (layer == null) continue;
                layer.setBounds(-in, -in, SIZE + in, SIZE + in);
                layer.draw(cv);
            }
        } else {
            d.setBounds(0, 0, SIZE, SIZE);
            d.draw(cv);
        }
        return b;
    }

    /** "square": opaque to the edges (adaptive, or a square tile): the page cuts a circle from it.
     *  "round": already a disc (transparent corners, opaque edge middles): shown as it is, no plate.
     *  "shaped": a logo with transparent space around it: shown on a soft disc of its own colour. */
    static String shape(Bitmap b, Drawable d) {
        if (Build.VERSION.SDK_INT >= 26 && d instanceof AdaptiveIconDrawable) return "square";
        int n = SIZE - 1, m = SIZE / 2, k = SIZE / 12;
        boolean corners = alpha(b, k, k) < 40 && alpha(b, n - k, k) < 40 && alpha(b, k, n - k) < 40 && alpha(b, n - k, n - k) < 40;
        boolean edges = alpha(b, m, 2) > 200 && alpha(b, 2, m) > 200 && alpha(b, m, n - 2) > 200 && alpha(b, n - 2, m) > 200;
        if (!corners && edges) return "square";
        if (corners && edges) return "round";
        return "shaped";
    }

    private static int alpha(Bitmap b, int x, int y) { return (b.getPixel(x, y) >>> 24) & 0xff; }

    private static String encode(Bitmap b) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        boolean webp = Build.VERSION.SDK_INT >= 30;              // a quarter of the PNG's size, and the page decodes it faster
        b.compress(webp ? Bitmap.CompressFormat.WEBP_LOSSLESS : Bitmap.CompressFormat.PNG, 100, o);
        b.recycle();
        return (webp ? "data:image/webp;base64," : "data:image/png;base64,") + Base64.encodeToString(o.toByteArray(), Base64.NO_WRAP);
    }
}
