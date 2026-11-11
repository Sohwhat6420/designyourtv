package dev.designyourtv.core;

/**
 * Brightness per app (S5 step 2): music apps do not need the peak a film does, so they sit at a
 * mid level; everything else (video apps, inputs, anything unknown) keeps the owner's level, which Eco restores. "-1" always
 * means "his level", never a number of ours. Pure Java, unit-tested.
 */
public final class AppBrightness {
    private AppBrightness() {}

    public static final int MUSIC = 70;
    public static final int HIS_LEVEL = -1;

    private static final String[] MUSIC_APPS = {
            "com.google.android.youtube.tvmusic",    // YouTube Music (TV)
            "com.google.android.apps.youtube.music", // YouTube Music (phone build, if sideloaded)
            "com.spotify.tv.android",                // Spotify (TV)
            "com.spotify.music",                     // Spotify (phone build, if sideloaded)
            "com.amazon.music.tv",                   // Amazon Music
            "deezer.android.tv",                     // Deezer
    };

    /**
     * @param pkg      the app now in front
     * @param own      our own package: its screens set their own level, so this says "his level" and the caller leaves them alone
     * @param musicMode YouTube is in front because YouTube Music opened it (HomeKeyService's musicMode)
     * @return the backlight level to hold for that app, or HIS_LEVEL
     */
    public static int levelFor(String pkg, String own, boolean musicMode) {
        if (pkg == null || pkg.isEmpty() || pkg.equals(own)) return HIS_LEVEL;
        if (musicMode && MusicCover.YT.equals(pkg)) return MUSIC;   // only YouTube itself: the flag can outlive the session
        for (String m : MUSIC_APPS) if (m.equals(pkg)) return MUSIC;
        return HIS_LEVEL;
    }
}
