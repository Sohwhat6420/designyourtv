package dev.designyourtv.core;

/**
 * The eco backlight (his family's 3 Nov ask: the TV left on the wallpaper should not burn power). While the wallpaper
 * is in front the panel's backlight drops to ECO, and to AOD after a long spell of nothing pressed; leaving puts his
 * own level back. Same shape as DensityLogic: his level is recorded before the first change, a change he makes himself
 * while it is dimmed wins, and a restore that fails is retried. Pure Java, unit-tested.
 */
public final class BacklightLogic {
    public static final int ECO = 35, AOD = 12;                    // of 100; his TV was at 100 (Xiaomi's maximum)
    public static final long AOD_AFTER_MS = 30 * 60_000L;

    public interface Panel { Integer get(); boolean set(int v); }
    public interface Store { Integer prev(); Integer ours(); boolean save(Integer prev, Integer ours); }

    public enum Result { DIMMED, ALREADY, RESTORED, FORGOT, NOTHING_TO_DO, FAILED }

    private BacklightLogic() {}

    /** Dim to level, recording the owner's level first (only the first time: a second dim keeps the true one). */
    public static Result dim(Panel p, Store s, int level) {
        if (level < 0 || level > 100) return Result.FAILED;
        Integer cur = p.get();
        if (cur == null) return Result.FAILED;
        Integer prev = s.prev(), ours = s.ours();
        if (prev != null && ours != null && !cur.equals(ours)) prev = cur;   // he changed it while dimmed: his new level counts
        if (prev == null) prev = cur;
        if (prev <= level) { s.save(null, null); return Result.ALREADY; }    // already as dark as this: leave his setting alone
        if (!s.save(prev, level)) return Result.FAILED;                      // no record, no change
        if (cur == level) return Result.ALREADY;
        return p.set(level) ? Result.DIMMED : Result.FAILED;
    }

    /** Put his level back. If the panel no longer shows ours, he changed it himself: forget, touch nothing. */
    public static Result restore(Panel p, Store s) {
        Integer prev = s.prev(), ours = s.ours();
        if (prev == null) return Result.NOTHING_TO_DO;
        Integer cur = p.get();
        if (cur == null) return Result.FAILED;
        if (ours != null && !cur.equals(ours)) { s.save(null, null); return Result.FORGOT; }
        if (!p.set(prev)) return Result.FAILED;                              // record kept for the next try
        s.save(null, null);
        return Result.RESTORED;
    }

    public static int target(long idleMs) { return idleMs >= AOD_AFTER_MS ? AOD : ECO; }
}
