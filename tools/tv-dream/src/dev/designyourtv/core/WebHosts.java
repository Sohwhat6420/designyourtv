package dev.designyourtv.core;

/** Where a WebApp page may go (pure, so CoreTest covers it). HTTPS to a listed host or its subdomains; plain HTTP
 *  only when the app is the hub page (the hub has no TLS), and then only to the hub itself. */
public final class WebHosts {
    private WebHosts() {}

    public static boolean allowed(String scheme, String host, String[] hosts, boolean httpOk) {
        if (host == null || hosts == null) return false;
        if (!"https".equals(scheme) && !(httpOk && "http".equals(scheme))) return false;
        host = host.toLowerCase(java.util.Locale.ROOT);
        for (String ok : hosts) if (host.equals(ok) || host.endsWith("." + ok)) return true;
        return false;
    }
}
