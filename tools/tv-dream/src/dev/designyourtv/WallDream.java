package dev.designyourtv;

import android.service.dreams.DreamService;
import android.view.KeyEvent;

/** The screensaver: the wallpaper page (hub or built-in copy). The D-pad reaches the dock; Back ends the dream. */
public class WallDream extends DreamService {
    private Web web;

    @Override public void onAttachedToWindow() {
        super.onAttachedToWindow();
        setInteractive(true);
        setFullscreen(true);
        setScreenBright(true);
        Density.restoreIfActive(this);          // one more safety net for the Claude tile
        web = new Web(this, new Web.Host() {
            @Override public void launched() { finish(); }
            @Override public void gone() { finish(); }                // the renderer died: end the dream, not the app
        });
        setContentView(web.root());
        web.view().requestFocus();
        web.start();
        Timers.up(this, web.view());
        Eco.start(this);
    }

    @Override public boolean dispatchKeyEvent(KeyEvent e) {
        if (web != null && web.key(e)) return true;
        if (e.getKeyCode() == KeyEvent.KEYCODE_BACK) { if (e.getAction() == KeyEvent.ACTION_UP) finish(); return true; }
        return super.dispatchKeyEvent(e);
    }

    @Override public void onDetachedFromWindow() {
        Eco.stop(this);
        if (web != null) { Timers.down(this, web.view()); web.destroy(); }
        web = null;
        super.onDetachedFromWindow();
    }
}
