package dev.designyourtv;

import android.webkit.WebView;

import java.util.HashSet;
import java.util.Set;

/**
 * Our pages' scripts stop while none of them is on screen. WebView.onPause stops drawing but not a page's timers, so
 * the wallpaper's clock, weather and widgets kept running behind every app, competing with its start and
 * making every app open slowly. pauseTimers is process-wide, so it waits until the last of our
 * screens (the wallpaper, the music cover, the screensaver, Claude) has gone, and the first one back resumes.
 */
final class Timers {
    private static final Set<Object> shown = new HashSet<>();

    private Timers() {}

    static synchronized void up(Object who, WebView any) {
        if (shown.add(who) && shown.size() == 1 && any != null) any.resumeTimers();
    }

    static synchronized void down(Object who, WebView any) {
        if (shown.remove(who) && shown.isEmpty() && any != null) any.pauseTimers();
    }

    /** True while none of our WebView screens is showing. */
    static synchronized boolean noneShown() {
        return shown.isEmpty();
    }
}
