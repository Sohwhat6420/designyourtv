package dev.designyourtv.core;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Which `intent:` links from the dock may start something. The page (tv-setup.html) builds
 * intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=<pkg>;end
 * or intent:#Intent;action=android.settings.SETTINGS;end. Everything else is dropped. Pure Java, unit-tested.
 */
public final class IntentPolicy {
    // our own screens, opened by class in Web.java
    public static final String OPEN_CLAUDE = "dev.designyourtv.action.CLAUDE", OPEN_DASHBOARD = "dev.designyourtv.action.DASHBOARD";
    public static final Set<String> PACKAGES = new HashSet<>(Arrays.asList(
        "com.netflix.ninja", "com.google.android.youtube.tv", "com.google.android.youtube.tvmusic",
        "com.amazon.amazonvideo.livingroom", "com.disney.disneyplus", "com.spotify.tv.android",
        "com.apple.atve.androidtv.appletv", "com.plexapp.android", "com.anthropic.claude",
        "com.iqiyi.i18n.tv", "sg.mediacorp.android"));                      // iQIYI and meWatch (the owner's 3 Nov dock)
    public static final Set<String> ACTIONS = new HashSet<>(Arrays.asList(
        "android.settings.SETTINGS", "android.settings.INPUT_METHOD_SETTINGS", "android.settings.WIFI_SETTINGS",
        "android.intent.action.ALL_APPS",                                    // Google TV's apps grid (launcherx deep link)
        "com.android.tv.action.VIEW_INPUTS",                                 // Xiaomi's input picker (livetv SelectInputActivity)
        OPEN_CLAUDE, OPEN_DASHBOARD));

    public static final class Target {
        public final String pkg, action;
        Target(String pkg, String action) { this.pkg = pkg; this.action = action; }
    }

    private IntentPolicy() {}

    /** @return what to start, or null to drop the link */
    public static Target parse(String url) { return parse(url, null); }

    /** As parse(url), and also any package in alsoAllowed: the apps the All apps drawer listed from the TV itself. */
    public static Target parse(String url, Set<String> alsoAllowed) {
        if (url == null || !url.startsWith("intent:")) return null;
        int h = url.indexOf("#Intent;");
        if (h < 0 || !url.endsWith(";end")) return null;
        String pkg = null, action = null, component = null;
        for (String part : url.substring(h + 8, url.length() - 4).split(";")) {
            int eq = part.indexOf('=');
            if (eq <= 0) continue;
            String k = part.substring(0, eq), v = part.substring(eq + 1);
            if (k.equals("package")) pkg = v;
            else if (k.equals("action")) action = v;
            else if (k.equals("component")) component = v;
            else if (k.equals("S.browser_fallback_url") || k.startsWith("S.") || k.startsWith("i.") || k.startsWith("B.")) return null;  // no extras
        }
        if (component != null) return null;                       // the dock never names a component
        if (pkg != null) {
            if (!pkg.matches("[A-Za-z][\\w]*(\\.[\\w]+)+") || (!PACKAGES.contains(pkg) && (alsoAllowed == null || !alsoAllowed.contains(pkg)))) return null;
            if (action != null && !action.equals("android.intent.action.MAIN")) return null;
            return new Target(pkg, null);
        }
        if (action != null && ACTIONS.contains(action)) return new Target(null, action);
        return null;
    }
}
