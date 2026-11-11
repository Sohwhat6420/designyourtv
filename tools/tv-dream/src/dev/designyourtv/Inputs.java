package dev.designyourtv;

import android.content.Context;
import android.content.Intent;
import android.media.tv.TvContract;
import android.media.tv.TvInputInfo;
import android.media.tv.TvInputManager;
import android.net.Uri;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

/**
 * The TV's physical inputs (HDMI 1, HDMI 2, AV...) for the dock's sidebar (S5 step 6). Read on demand when the page opens
 * the sidebar, and one input is opened when it is picked: no listener, no timer, nothing that runs otherwise.
 */
final class Inputs {
    private Inputs() {}

    private static TvInputManager mgr(Context c) { return (TvInputManager) c.getSystemService(Context.TV_INPUT_SERVICE); }

    private static boolean physical(TvInputInfo i) {
        return i.isPassthroughInput() && i.getType() != TvInputInfo.TYPE_TUNER && i.getType() != TvInputInfo.TYPE_OTHER;
    }

    /** [{id, label, type: "hdmi"|"av"|"other", live: bool}] of the passthrough inputs; "[]" when the TV won't say. */
    static String json(Context c) {
        JSONArray out = new JSONArray();
        try {
            TvInputManager m = mgr(c);
            if (m == null) return "[]";
            List<TvInputInfo> all = m.getTvInputList();
            for (TvInputInfo i : all) {
                if (!physical(i)) continue;
                CharSequence custom = i.loadCustomLabel(c), label = custom != null && custom.length() > 0 ? custom : i.loadLabel(c);
                JSONObject o = new JSONObject();
                o.put("id", i.getId());
                o.put("label", String.valueOf(label));
                o.put("type", i.getType() == TvInputInfo.TYPE_HDMI ? "hdmi" : "av");
                o.put("live", m.getInputState(i.getId()) == TvInputManager.INPUT_STATE_CONNECTED);
                out.put(o);
            }
        } catch (Exception e) {
            Log.w(Density.TAG, "inputs list failed: " + e);
            return "[]";
        }
        return out.toString();
    }

    /** Opens one of the listed inputs (the id must be one the TV itself listed). @return false when it could not. */
    static boolean open(Context c, String id) {
        if (id == null) return false;
        try {
            TvInputManager m = mgr(c);
            if (m == null) return false;
            for (TvInputInfo i : m.getTvInputList()) {
                if (!physical(i) || !i.getId().equals(id)) continue;
                Uri u = TvContract.buildChannelUriForPassthroughInput(id);
                c.startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                return true;
            }
        } catch (Exception e) {
            Log.w(Density.TAG, "input not opened: " + e);
        }
        return false;
    }
}
