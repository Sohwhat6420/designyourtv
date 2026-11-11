package dev.designyourtv.core;

/**
 * Settings.Secure enabled_accessibility_services is a ':'-separated list of components. The TV dropped our Home-button
 * service from it (3 Nov evening: the setting read null and Home stopped opening the wallpaper), so the app puts it back
 * at boot, after an update and whenever the wallpaper opens. Pure Java, unit-tested.
 */
public final class A11yList {
    private A11yList() {}

    /** The list with svc in it, other services kept in order; null when svc is already there (nothing to write). */
    public static String with(String list, String svc) {
        if (list == null || list.trim().isEmpty() || list.trim().equals("null")) return svc;
        for (String s : list.split(":")) if (same(s.trim(), svc)) return null;
        return list + ":" + svc;
    }

    /** The list without svc (either spelling), other services kept in order; "null" when nothing is left. */
    public static String without(String list, String svc) {
        if (list == null || list.trim().isEmpty() || list.trim().equals("null")) return "null";
        StringBuilder b = new StringBuilder();
        for (String s : list.split(":")) {
            if (s.trim().isEmpty() || same(s.trim(), svc)) continue;
            if (b.length() > 0) b.append(':');
            b.append(s.trim());
        }
        return b.length() == 0 ? "null" : b.toString();
    }

    /** "pkg/.Cls" and "pkg/pkg.Cls" name the same component. */
    static boolean same(String a, String b) { return full(a).equalsIgnoreCase(full(b)); }

    private static String full(String c) {
        int k = c.indexOf('/');
        if (k < 0) return c;
        String pkg = c.substring(0, k), cls = c.substring(k + 1);
        return pkg + "/" + (cls.startsWith(".") ? pkg + cls : cls);
    }
}
