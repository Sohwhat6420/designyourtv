package dev.designyourtv.core;

/**
 * YouTube Music keeps playing when Home is pressed (otherwise the
 * music stops the moment the app leaves the screen).
 *
 * Measured on the TV, 4 Nov 00:24: YouTube Music for Android TV (com.google.android.youtube.tvmusic 1.12.07) is a shell
 * that hands playback to the YouTube TV app (com.google.android.youtube.tv 7.28). Neither declares a media service or
 * FOREGROUND_SERVICE, so the moment another activity takes the screen the player stops itself ("releasing player"
 * within 1 s of Home, the media session gone, oom_score_adj 0 -> 700), and this low-RAM TV (1.8 GB,
 * ro.config.low_ram) later reaps the cached process (exit-info: LOW_MEMORY, importance 400). Google TV's own Home does
 * the same; nothing we disabled is involved.
 *
 * So while YouTube Music plays, Home does not switch apps: the wallpaper is drawn over the player as an accessibility
 * overlay and YouTube stays the resumed activity. Pure Java, unit-tested; HomeKeyService and MusicOverlay do the rest.
 *
 * Measured again 4 Nov 00:54, with the cover up: two minutes later the screensaver started and YouTube stopped all the
 * same. YouTube's keep-screen-on only counts while its window is visible, and the cover hides it. So the cover holds
 * the screen on itself while sound plays, and lets go once it stops.
 */
public final class MusicCover {
    private MusicCover() {}

    public static final String YT = "com.google.android.youtube.tv", YTM = "com.google.android.youtube.tvmusic";

    public enum Home { SHOW_COVER, HIDE_COVER, OPEN_WALL, OPEN_GOOGLE_TV }

    /** A short Home press. wallInFront: our wallpaper activity is in front (the old toggle to Google TV). */
    public static Home onHome(boolean coverShown, String frontPkg, boolean musicMode, boolean audioActive, boolean wallInFront) {
        if (coverShown) return Home.HIDE_COVER;                       // Home again: back to the player
        if (playingMusic(frontPkg, musicMode, audioActive)) return Home.SHOW_COVER;
        return wallInFront ? Home.OPEN_GOOGLE_TV : Home.OPEN_WALL;
    }

    /** YouTube is in front because YouTube Music opened it, and sound is playing. A plain YouTube video (no musicMode)
     *  still leaves on Home, as he expects. */
    public static boolean playingMusic(String frontPkg, boolean musicMode, boolean audioActive) {
        return audioActive && musicMode && (YT.equals(frontPkg) || YTM.equals(frontPkg));
    }

    /** The front activity changed: is YouTube Music's session still the one in front? YouTube Music starts it (true);
     *  YouTube, our own windows and System UI keep it as it was; anything else ends it. Returns the new musicMode. */
    public static boolean musicModeAfter(boolean musicMode, String pkg, String self) {
        if (YTM.equals(pkg)) return true;
        if (YT.equals(pkg) || pkg.equals(self) || pkg.equals("com.android.systemui")) return musicMode;
        return false;
    }

    /** The cover stays only while YouTube (or its music shell) or our own windows are in front. The screensaver ends it:
     *  it only starts once the music has stopped (the cover keeps the screen on while sound plays), and it shows the
     *  wallpaper itself. */
    public static boolean keepCover(String pkg, String cls, String self) {
        if (DREAM.equals(cls)) return false;
        return YT.equals(pkg) || YTM.equals(pkg) || pkg.equals(self) || pkg.equals("com.android.systemui");
    }

    /** Android 11 runs every screensaver in this activity, under the dream's own package. */
    public static final String DREAM = "android.service.dreams.DreamActivity";

    /** What the cover does with a remote key: pass it to the player (media and volume), close the cover (Back), or give
     *  it to the page as a DOM key (the cover never takes window focus, so YouTube keeps it). Null key = pass. */
    public static String pageKey(int keyCode) {
        switch (keyCode) {
            case 19: return "ArrowUp";      // KEYCODE_DPAD_UP
            case 20: return "ArrowDown";
            case 21: return "ArrowLeft";
            case 22: return "ArrowRight";
            case 23: case 66: case 160: return "Enter";   // DPAD_CENTER, ENTER, NUMPAD_ENTER
            default: return null;
        }
    }

    public static boolean isBack(int keyCode) { return keyCode == 4 || keyCode == 111; }   // BACK, ESCAPE

    /** CH+/CH- turn the painting, as on the wallpaper activity. */
    public static boolean isChannel(int keyCode) { return keyCode == 166 || keyCode == 167; }
}
