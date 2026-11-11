package dev.designyourtv.core;

/**
 * What is in front, read from the usage log (UsageEvents): the component whose latest event is "moved to foreground" and which
 * has not moved to the background since. HomeKeyService follows Google TV's home to the wallpaper only when this still says
 * Google TV's home, so a stale reading (6 Nov: the service re-binds with no window event) never pulls the wallpaper over an app
 * he is watching. Events must be added in time order, as UsageEvents delivers them. Pure Java, unit-tested.
 */
public final class UsageFront {
    private String pkg = "", cls = "";
    private long since = -1;

    /** One event: foreground = MOVE_TO_FOREGROUND, otherwise MOVE_TO_BACKGROUND (other event types are not passed in). */
    public void add(long time, boolean foreground, String p, String c) {
        if (p == null || c == null) return;
        if (foreground) { pkg = p; cls = c; since = time; }
        else if (p.equals(pkg) && c.equals(cls)) { pkg = ""; cls = ""; since = -1; }
    }

    public String pkg() { return pkg; }
    public String cls() { return cls; }
    /** Time of the foreground event, -1 when nothing is known to be in front. */
    public long since() { return since; }
    public boolean known() { return !pkg.isEmpty(); }

    /** True only when the log shows exactly this component in front. Unknown is false: when in doubt, leave the screen alone. */
    public boolean isFront(String p, String c) { return known() && pkg.equals(p) && cls.equals(c); }
}
