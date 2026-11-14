package dev.designyourtv;

import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;

/**
 * Turns the HomeAlias on or off. On Android 11, the shell may not change another app's component state, but an app may
 * change its own. Only callers holding WRITE_SECURE_SETTINGS can send this broadcast (the manifest's permission): the
 * adb shell, and this app once tv-apply has granted it. Nothing else on the TV can.
 *   adb shell am broadcast -a dev.designyourtv.HOME --ez on true -n dev.designyourtv/.HomeToggle
 * It also records whether the owner wants the Home-button service kept on (tv-apply --home-key on|off sends it):
 *   adb shell am broadcast -a dev.designyourtv.HOME_KEY --ez keep true -n dev.designyourtv/.HomeToggle
 */
public class HomeToggle extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) {
        if (i != null && "dev.designyourtv.HOME_KEY".equals(i.getAction())) {
            boolean keep = i.getBooleanExtra("keep", false);
            c.getSharedPreferences("homekey", Context.MODE_PRIVATE).edit().putBoolean("keep", keep).commit();
            setResultCode(keep ? 1 : 0);
            return;
        }
        if (i == null || !"dev.designyourtv.HOME".equals(i.getAction())) return;
        boolean on = i.getBooleanExtra("on", false);
        c.getPackageManager().setComponentEnabledSetting(new ComponentName(c, "dev.designyourtv.HomeAlias"),
            on ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED : PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
            PackageManager.DONT_KILL_APP);
        setResultCode(on ? 1 : 0);
    }
}
