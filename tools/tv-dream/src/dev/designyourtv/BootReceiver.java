package dev.designyourtv;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After a reboot or a crash, WindowManager re-applies a forced density; this puts it back if it was ours. */
public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) {
        String a = i == null ? null : i.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) { Density.restoreIfActive(c); Eco.restoreIfActive(c); HomeKeyService.ensure(c); }
    }
}
