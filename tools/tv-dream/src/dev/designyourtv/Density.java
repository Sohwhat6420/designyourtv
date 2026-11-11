package dev.designyourtv;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.hardware.display.DisplayManager;
import android.util.DisplayMetrics;
import android.view.Display;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.util.Log;

import dev.designyourtv.core.DensityLogic;

import java.lang.reflect.Method;

/**
 * The Android side of the density switch: the WindowManager call SecondScreen uses without root
 * (farmerbb/SecondScreen, NonRootUtils.wmDensity: IWindowManager.setForcedDisplayDensityForUser /
 * clearForcedDisplayDensityForUser, which need WRITE_SECURE_SETTINGS, granted once over adb), and the state in
 * SharedPreferences written with commit() before anything changes.
 */
public final class Density {
    static final String TAG = "DesignYourTV";
    static final String PREFS = "density";
    private static final int USER_CURRENT_OR_SELF = -3;   // android.os.UserHandle

    private Density() {}

    public static boolean canWrite(Context c) {
        return c.checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") == PackageManager.PERMISSION_GRANTED;
    }

    static final class AndroidDisplay implements DensityLogic.Display {
        private final Context c;
        AndroidDisplay(Context c) { this.c = c.getApplicationContext(); }
        private static Object wm() throws Exception {
            try {
                Class<?> sm = Class.forName("android.os.ServiceManager");
                IBinder b = (IBinder) sm.getMethod("getService", String.class).invoke(null, "window");
                return Class.forName("android.view.IWindowManager$Stub").getMethod("asInterface", IBinder.class).invoke(null, b);
            } catch (Exception e) {
                Log.w(TAG, "window manager unreachable: " + e);
                throw e;
            }
        }
        /** Methods are looked up on the IWindowManager interface, not on the binder proxy class (whose members the
         *  hidden-API rules can block); invoking the interface method dispatches to the proxy all the same. */
        private static Method m(String name, Class<?>... types) throws Exception {
            try { return Class.forName("android.view.IWindowManager").getMethod(name, types); }
            catch (Exception e) { Log.w(TAG, "IWindowManager." + name + " not reachable: " + e); throw e; }
        }
        private static void call(Method m, Object w, Object... args) throws Exception {
            try { m.invoke(w, args); }
            catch (java.lang.reflect.InvocationTargetException e) {
                Throwable c = e.getCause() != null ? e.getCause() : e;
                Log.w(TAG, m.getName() + " refused: " + c);
                throw c instanceof Exception ? (Exception) c : new Exception(c);
            } catch (Exception e) {
                Log.w(TAG, m.getName() + " unreachable: " + e);
                throw e;
            }
        }
        public Integer currentOverride() throws Exception {
            // The live logical density of the default display (public API: it includes any override) against the
            // display's own density. Measured on the API 33 emulator, 3 Nov: Settings.Secure display_density_forced
            // throws for apps targeting Android 12+, and IWindowManager.getBaseDisplayDensity is hidden from apps.
            // First choice: ask WindowManager over binder (always live; reachable because we target SDK 26).
            // In-process Display metrics stay cached at the old density inside a running process (measured on the
            // API 33 emulator, 3 Nov: the guard read 420 while the screen was at 240, and stood down).
            try {
                Object w = wm();
                int i0 = (Integer) m("getInitialDisplayDensity", int.class).invoke(w, 0);
                int b0 = (Integer) m("getBaseDisplayDensity", int.class).invoke(w, 0);
                Log.i(TAG, "density now " + b0 + ", the display's own " + i0 + " (WindowManager)");
                if (i0 > 0 && b0 > 0) return b0 != i0 ? Integer.valueOf(b0) : null;
            } catch (Exception e) {
                Log.w(TAG, "WindowManager density read failed (" + e + "); using the display metrics");
            }
            int init;
            try { init = (Integer) m("getInitialDisplayDensity", int.class).invoke(wm(), 0); }
            catch (Exception e) { init = DisplayMetrics.DENSITY_DEVICE_STABLE; }
            DisplayManager dmgr = (DisplayManager) c.getSystemService(Context.DISPLAY_SERVICE);
            Display d = dmgr == null ? null : dmgr.getDisplay(Display.DEFAULT_DISPLAY);
            if (d == null || init <= 0) {
                return DensityLogic.parseForced(Settings.Secure.getString(c.getContentResolver(), "display_density_forced"));
            }
            DisplayMetrics dm = new DisplayMetrics();
            d.getRealMetrics(dm);
            Log.i(TAG, "density now " + dm.densityDpi + ", the display's own " + init);
            return dm.densityDpi > 0 && dm.densityDpi != init ? Integer.valueOf(dm.densityDpi) : null;
        }
        public void setOverride(int dpi) throws Exception {
            Object w = wm();
            if (Build.VERSION.SDK_INT >= 25) call(m("setForcedDisplayDensityForUser", int.class, int.class, int.class), w, 0, dpi, USER_CURRENT_OR_SELF);
            else call(m("setForcedDisplayDensity", int.class, int.class), w, 0, dpi);
        }
        public void clearOverride() throws Exception {
            Object w = wm();
            if (Build.VERSION.SDK_INT >= 25) call(m("clearForcedDisplayDensityForUser", int.class, int.class), w, 0, USER_CURRENT_OR_SELF);
            else call(m("clearForcedDisplayDensity", int.class), w, 0);
        }
    }

    static final class PrefsStore implements DensityLogic.Store {
        private final SharedPreferences p;
        PrefsStore(Context c) { p = c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
        public boolean active() { return p.getBoolean("active", false); }
        public Integer prev() { return p.contains("prev") ? p.getInt("prev", 0) : null; }
        public int ours() { return p.getInt("ours", 0); }
        public boolean save(Integer prev, int ours, long at) {
            SharedPreferences.Editor e = p.edit().putBoolean("active", true).putInt("ours", ours).putLong("at", at);
            if (prev == null) e.remove("prev"); else e.putInt("prev", prev);
            return e.commit();
        }
        public boolean clear() { return p.edit().putBoolean("active", false).remove("prev").remove("ours").remove("at").commit(); }
    }

    public static DensityLogic.Result apply(Context c, int dpi) {
        DensityLogic.Result r = DensityLogic.apply(new AndroidDisplay(c), new PrefsStore(c), dpi, System.currentTimeMillis());
        Log.i(TAG, "density apply " + dpi + ": " + r);
        return r;
    }

    /** Safe to call from anywhere, any number of times. */
    public static DensityLogic.Result restoreIfActive(Context c) {
        PrefsStore s = new PrefsStore(c);
        if (!s.active()) return DensityLogic.Result.NOTHING_TO_DO;
        DensityLogic.Result r = DensityLogic.restore(new AndroidDisplay(c), s);
        Log.i(TAG, "density restore: " + r);
        return r;
    }

    public static int savedDpi(Context c) { return c.getSharedPreferences("tile", Context.MODE_PRIVATE).getInt("dpi", 240); }
    public static void saveDpi(Context c, int dpi) { c.getSharedPreferences("tile", Context.MODE_PRIVATE).edit().putInt("dpi", dpi).commit(); }
}
