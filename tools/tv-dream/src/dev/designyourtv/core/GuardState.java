package dev.designyourtv.core;

/**
 * Decides when Claude has left the screen, from the foreground package the guard service reads every 1.5 s.
 * Pure Java, unit-tested on the JVM.
 *
 *  - Packages that sit on top of Claude without ending it (our own tile, System UI, keyboards, the Google account
 *    picker, permission dialogs) are neutral.
 *  - Any other app (the launcher after Home, Netflix from the dock, Settings) for AWAY_GRACE_MS means Claude is
 *    gone: restore.
 *  - If Claude never comes to the front within LAUNCH_TIMEOUT_MS, restore anyway.
 */
public final class GuardState {
    public static final String CLAUDE = "com.anthropic.claude";
    public static final long AWAY_GRACE_MS = 3000, LAUNCH_TIMEOUT_MS = 60000;

    private final String self;
    private final long startedAt;
    private boolean claudeSeen = false;
    private long awaySince = -1;

    public GuardState(String selfPackage, long startedAt) { this.self = selfPackage; this.startedAt = startedAt; }

    public boolean claudeSeen() { return claudeSeen; }

    public static boolean neutral(String pkg, String self) {
        return pkg.equals(self) || pkg.equals("android") || pkg.equals("com.android.systemui")
            || pkg.contains("inputmethod") || pkg.endsWith("leanback.ime") || pkg.endsWith(".ime")
            || pkg.equals("com.google.android.gms") || pkg.equals("com.google.android.gsf")
            || pkg.equals("com.android.permissioncontroller") || pkg.equals("com.google.android.permissioncontroller")
            || pkg.equals("com.android.packageinstaller") || pkg.equals("com.google.android.packageinstaller");
    }

    /** @param pkg the most recent foreground package, or null when it is unknown; @return true = restore now */
    public boolean onForeground(String pkg, long now) {
        if (pkg == null) return !claudeSeen && now - startedAt > LAUNCH_TIMEOUT_MS;
        if (pkg.equals(CLAUDE)) { claudeSeen = true; awaySince = -1; return false; }
        if (neutral(pkg, self)) return !claudeSeen && now - startedAt > LAUNCH_TIMEOUT_MS;
        if (!claudeSeen) return now - startedAt > LAUNCH_TIMEOUT_MS;
        if (awaySince < 0) awaySince = now;
        return now - awaySince >= AWAY_GRACE_MS;
    }
}
