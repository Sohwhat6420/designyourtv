package dev.designyourtv.core;

/** The hub, else an optional mirror of it (another always-on device), else the built-in copy. Pure Java, unit-tested.
 *  tools/build-tv-apk.mjs swaps HUB for --hub and MIRROR for --mirror (or the hub again) at build time. */
public final class HubChooser {
    public static final String HUB = "http://192.168.1.10:8790";
    /** An optional second server with the same pages, paintings and last good /api answers, for when the hub is off. */
    public static final String MIRROR = "http://192.168.1.11:8792";
    public static final String[] ORIGINS = { HUB, MIRROR };
    public static final String PATH = "/tv-setup.html?kiosk=tv";
    public static final String PAGE = HUB + PATH;
    public static final String HEALTH = HUB + "/api/health";
    public static final String OFFLINE = "file:///android_asset/offline/index.html";
    public static final int TIMEOUT_MS = 4000;
    public static final long RECHECK_MS = 60000;

    private HubChooser() {}

    /** The hub's /api/health says {"ok":true,...}. */
    public static boolean healthy(int status, String body) {
        return status == 200 && body != null && body.replaceAll("\\s", "").contains("\"ok\":true");
    }

    public static String choose(boolean hubOk) { return hubOk ? PAGE : OFFLINE; }

    /** The page to show from the first origin that answered (null: none did). */
    public static String pageFrom(String origin) { return origin == null ? OFFLINE : origin + PATH; }

    /** One of our two servers: the hub or the POCO's mirror. */
    public static boolean ours(String url) {
        if (url == null || url.contains("..")) return false;
        for (String o : ORIGINS) if (url.startsWith(o + "/")) return true;
        return false;
    }

    /** Recheck this often while a change of origin is pending (a miss, or a better origin back). */
    public static final long PENDING_RECHECK_MS = 15000;
    public static final int LEAVE_AFTER = 3, RETURN_AFTER = 2;

    /** Which origin the page should come from, with hysteresis (4 Nov: one missed 4 s probe moved the page to the
     *  POCO and back a minute later; each move reloads the page and the POCO's origin has its own saved state, so the
     *  painting jumped). The origin showing is left only after LEAVE_AFTER checks in a row without it, and a better one
     *  (the hub, ahead of the POCO) is taken back only after RETURN_AFTER checks in a row. The first check and the
     *  built-in copy move at once: there is no working page to keep. */
    public static final class Sticky {
        private boolean started;
        private String showing;                  // null: the built-in copy
        private int misses, better;

        private static int rank(String o) {
            for (int k = 0; k < ORIGINS.length; k++) if (ORIGINS[k].equals(o)) return k;
            return ORIGINS.length;
        }

        /** Seed with the origin already loaded (e.g. a page rebuilt after onStop), so hysteresis holds from check 1. */
        public void seed(String origin) {
            if (origin != null) { started = true; showing = origin; misses = better = 0; }
        }

        /** Reset state so the next check is accepted immediately (e.g. after a page load failure). */
        public void reset() {
            started = false; showing = null; misses = better = 0;
        }

        /** @param best the first of ORIGINS that answered this check, or null. @return the origin to show. */
        public String next(String best) {
            if (!started || showing == null) { started = true; showing = best; misses = better = 0; return showing; }
            if (eq(best, showing)) { misses = better = 0; return showing; }
            if (rank(best) < rank(showing)) {      // a better one is back; the one showing may still be up
                misses = 0;
                if (++better >= RETURN_AFTER) { showing = best; better = 0; }
            } else {                              // the one showing missed this check
                better = 0;
                if (++misses >= LEAVE_AFTER) { showing = best; misses = 0; }
            }
            return showing;
        }

        /** A change is under way: check again soon. */
        public boolean pending() { return misses > 0 || better > 0; }

        private static boolean eq(String a, String b) { return a == null ? b == null : a.equals(b); }
    }

    /** Only our servers' own pages load in the WebView; everything else (other sites, file: outside our assets) is dropped. */
    public static boolean mayLoad(String url) {
        if (url == null) return false;
        if (ours(url)) return true;
        return url.startsWith("file:///android_asset/offline/") && !url.contains("..");
    }
}
