package dev.designyourtv;

import android.content.Context;
import android.view.accessibility.AccessibilityNodeProvider;
import android.webkit.WebView;

/**
 * A WebView that never starts Chromium's accessibility engine. The engine starts the first time Android asks the view
 * for its node provider, and Android asks whenever any accessibility service runs: ours (HomeKeyService) always does.
 * Once started it rebuilt the page's accessibility tree on every DOM change, 133-151 ms of the main thread on each
 * painting change (traces on the TV, 4 Nov), and it stayed on with the service switched off. Neither
 * IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS (1.0.22) nor removing the service stopped it. Nothing here is for a
 * screen reader: HomeKeyService reads no screen content, and the pages are driven by the remote.
 */
final class QuietWebView extends WebView {
    QuietWebView(Context c) { super(c); }

    @Override public AccessibilityNodeProvider getAccessibilityNodeProvider() { return null; }
}
