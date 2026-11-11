package dev.designyourtv.core;

/**
 * The density switch behind the Claude tile, with no Android types so it can be unit-tested on a plain JVM.
 *
 * Rules (the TV must never be left at the low density):
 *  - The state is saved (commit) BEFORE the density is changed, and holds the value that was there before us.
 *  - A second apply while a switch is active first restores, so "prev" is always the TV's own value, never ours.
 *  - Restore puts back exactly what was there (an older override, or none), and only if the screen still shows
 *    OUR value; if someone else changed it since (for example `wm density reset` from the runbook) we only forget.
 *  - If restoring fails, the state is kept, so the next boot, dream or tile open tries again.
 */
public final class DensityLogic {
    public interface Display {
        /** The current forced density, or null when the TV is at its physical density. */
        Integer currentOverride() throws Exception;
        void setOverride(int dpi) throws Exception;
        void clearOverride() throws Exception;
    }

    public interface Store {
        boolean active();
        /** The override that was there before us; null means "none". */
        Integer prev();
        int ours();
        /** Must be durable when it returns (SharedPreferences.commit()). */
        boolean save(Integer prev, int ours, long at);
        boolean clear();
    }

    public enum Result { APPLIED, ALREADY, FAILED, RESTORED, NOTHING_TO_DO, FORGOT, RESTORE_FAILED }

    public static final int MIN_DPI = 120, MAX_DPI = 640;

    private DensityLogic() {}

    public static boolean validDpi(int dpi) { return dpi >= MIN_DPI && dpi <= MAX_DPI; }

    public static Result apply(Display d, Store s, int target, long now) {
        if (!validDpi(target)) return Result.FAILED;
        if (s.active()) {
            Result r = restore(d, s);
            if (r == Result.RESTORE_FAILED) return Result.FAILED;      // never stack a second switch on a stuck one
        }
        Integer cur;
        try { cur = d.currentOverride(); } catch (Exception e) { return Result.FAILED; }
        if (cur != null && cur == target) return Result.ALREADY;      // the owner's own setting already: not ours to undo
        if (!s.save(cur, target, now)) return Result.FAILED;          // write-ahead: no record, no change
        try {
            d.setOverride(target);
            return Result.APPLIED;
        } catch (Exception e) {
            s.clear();
            return Result.FAILED;
        }
    }

    public static Result restore(Display d, Store s) {
        if (!s.active()) return Result.NOTHING_TO_DO;
        Integer cur;
        try { cur = d.currentOverride(); } catch (Exception e) { return Result.RESTORE_FAILED; }
        if (cur == null || cur != s.ours()) {                          // not our value any more
            s.clear();
            return Result.FORGOT;
        }
        try {
            Integer prev = s.prev();
            if (prev == null) d.clearOverride(); else d.setOverride(prev);
        } catch (Exception e) {
            return Result.RESTORE_FAILED;                              // keep the state: retried on boot / next open
        }
        s.clear();
        return Result.RESTORED;
    }

    /** Parses Settings.Secure display_density_forced ("" or null = none). */
    public static Integer parseForced(String v) {
        if (v == null) return null;
        v = v.trim();
        if (v.isEmpty()) return null;
        try { int n = Integer.parseInt(v); return n > 0 ? n : null; } catch (NumberFormatException e) { return null; }
    }
}
