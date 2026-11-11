package dev.designyourtv;

import android.content.ComponentCallbacks2;
import android.content.ComponentName;
import android.content.Context;
import android.graphics.Bitmap;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.os.Handler;
import android.os.Looper;
import android.service.notification.NotificationListenerService;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * What the TV itself is playing (Spotify through Spotify Connect, YouTube Music, any app with a media session), for the
 * wallpaper's now-playing card. The hub's /api/nowplaying only sees the laptop. Android lets an app
 * read other apps' media sessions only while it is an enabled notification listener, so this class is one; we never
 * read notifications themselves. Off until allowed once over adb:
 *   adb shell cmd notification allow_listener dev.designyourtv/dev.designyourtv.NowPlaying
 * Undo: cmd notification disallow_listener (same component).
 */
public final class NowPlaying extends NotificationListenerService {
    interface Sink { void nowPlaying(String json); }

    private static final Handler H = new Handler(Looper.getMainLooper());
    private static final List<Sink> SINKS = new CopyOnWriteArrayList<Sink>();
    private static volatile String last = "{\"status\":\"idle\"}";
    private static String lastArtKey;
    private static String lastArt;

    private MediaSessionManager msm;
    private MediaController cur;
    private final MediaSessionManager.OnActiveSessionsChangedListener changed = new MediaSessionManager.OnActiveSessionsChangedListener() {
        @Override public void onActiveSessionsChanged(List<MediaController> list) { pick(list); }
    };
    private final MediaController.Callback cb = new MediaController.Callback() {
        @Override public void onMetadataChanged(MediaMetadata m) { publish(); }
        @Override public void onPlaybackStateChanged(PlaybackState s) { publish(); }
        @Override public void onSessionDestroyed() { cur = null; publish(); }
    };

    /** The latest state as JSON, for a page that has just loaded. */
    static String latest() { return last; }
    static void add(Sink s) { SINKS.add(s); }
    static void remove(Sink s) { SINKS.remove(s); }

    @Override public void onListenerConnected() {
        try {
            msm = (MediaSessionManager) getSystemService(Context.MEDIA_SESSION_SERVICE);
            ComponentName me = new ComponentName(this, NowPlaying.class);
            msm.addOnActiveSessionsChangedListener(changed, me, H);
            pick(msm.getActiveSessions(me));
        } catch (SecurityException e) { Log.w(Density.TAG, "now playing: not an allowed listener", e); }
    }

    @Override public void onListenerDisconnected() {
        if (msm != null) msm.removeOnActiveSessionsChangedListener(changed);
        if (cur != null) cur.unregisterCallback(cb);
        cur = null; publish();
    }

    @Override public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (SINKS.isEmpty() && (level >= ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN || level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW)) {
            lastArtKey = null; lastArt = null;
            try {
                if (last.contains("\"art\":")) {
                    JSONObject o = new JSONObject(last);
                    o.remove("art");
                    last = o.toString();
                }
            } catch (Exception ignored) { }
        }
    }

    /** The session that is playing wins; otherwise the first (Android lists the most recent first). */
    private void pick(List<MediaController> list) {
        MediaController best = null;
        if (list != null) for (MediaController c : list) {
            PlaybackState s = c.getPlaybackState();
            if (s != null && s.getState() == PlaybackState.STATE_PLAYING) { best = c; break; }
            if (best == null) best = c;
        }
        if (cur != null && best != null && cur.getSessionToken().equals(best.getSessionToken())) { publish(); return; }
        if (cur != null) cur.unregisterCallback(cb);
        cur = best;
        if (cur != null) cur.registerCallback(cb, H);
        publish();
    }

    private void publish() {
        String json = describe(cur);
        if (json.equals(last)) return;
        last = json;
        for (Sink s : SINKS) s.nowPlaying(json);
    }

    /** The same shape as the hub's /api/nowplaying where it overlaps, plus where it came from. */
    private static String describe(MediaController c) {
        try {
            JSONObject o = new JSONObject();
            MediaMetadata m = c == null ? null : c.getMetadata();
            PlaybackState s = c == null ? null : c.getPlaybackState();
            if (m == null || m.getString(MediaMetadata.METADATA_KEY_TITLE) == null) {
                lastArtKey = null; lastArt = null;
                return o.put("status", "idle").toString();
            }
            int st = s == null ? PlaybackState.STATE_NONE : s.getState();
            o.put("status", st == PlaybackState.STATE_PLAYING ? "playing" : st == PlaybackState.STATE_PAUSED ? "paused" : "stopped");
            o.put("source", "tv");
            o.put("app", c.getPackageName());
            o.put("title", m.getString(MediaMetadata.METADATA_KEY_TITLE));
            String artist = m.getString(MediaMetadata.METADATA_KEY_ARTIST);
            if (artist == null) artist = m.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST);
            if (artist != null) o.put("artist", artist);
            String album = m.getString(MediaMetadata.METADATA_KEY_ALBUM);
            if (album != null) o.put("album", album);
            long dur = m.getLong(MediaMetadata.METADATA_KEY_DURATION);
            if (dur > 0) o.put("duration_s", dur / 1000.0);
            if (s != null && s.getPosition() >= 0) {
                o.put("position_s", s.getPosition() / 1000.0);
                o.put("speed", s.getPlaybackSpeed());
                o.put("at", System.currentTimeMillis() - (android.os.SystemClock.elapsedRealtime() - s.getLastPositionUpdateTime()));
            }
            String art = art(m);
            if (art != null) o.put("art", art);
            return o.toString();
        } catch (Exception e) {
            Log.w(Density.TAG, "now playing: describe failed", e);
            return "{\"status\":\"idle\"}";
        }
    }

    /** Album art as a small JPEG data URL (256 px), encoded once per track. */
    private static String art(MediaMetadata m) {
        String key = m.getString(MediaMetadata.METADATA_KEY_TITLE) + "\u0000" + m.getString(MediaMetadata.METADATA_KEY_ALBUM);
        if (key.equals(lastArtKey)) return lastArt;
        Bitmap b = m.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART);
        if (b == null) b = m.getBitmap(MediaMetadata.METADATA_KEY_ART);
        if (b == null) b = m.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON);
        String out = null;
        if (b != null) {
            int w = b.getWidth(), h = b.getHeight(), side = 256;
            float k = Math.min(1f, side / (float) Math.max(w, h));
            Bitmap small = k < 1f ? Bitmap.createScaledBitmap(b, Math.round(w * k), Math.round(h * k), true) : b;
            try {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                small.compress(Bitmap.CompressFormat.JPEG, 82, bos);
                out = "data:image/jpeg;base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
            } finally {
                if (small != b) small.recycle();
            }
        }
        lastArtKey = key; lastArt = out;
        return out;
    }
}
