package dev.designyourtv.core;

import java.util.ArrayList;
import java.util.List;

/** Plain-JVM unit tests for the core classes (no Android, no JUnit). Exit code 0 = all passed. */
public final class CoreTest {
    static int run = 0, failed = 0;
    static void check(String name, boolean ok) { run++; if (!ok) { failed++; System.out.println("FAIL  " + name); } else System.out.println("PASS  " + name); }

    /** A fake TV display that records every call. */
    static final class FakeDisplay implements DensityLogic.Display {
        Integer override; boolean failSet, failClear, failRead; final List<String> calls = new ArrayList<>();
        FakeDisplay(Integer o) { override = o; }
        public Integer currentOverride() throws Exception { calls.add("read"); if (failRead) throw new Exception("read"); return override; }
        public void setOverride(int dpi) throws Exception { calls.add("set " + dpi); if (failSet) throw new Exception("set"); override = dpi; }
        public void clearOverride() throws Exception { calls.add("clear"); if (failClear) throw new Exception("clear"); override = null; }
    }
    /** A store that survives "reboots" (a new FakeDisplay with the same store) and logs the order of events. */
    static final class FakeStore implements DensityLogic.Store {
        boolean active; Integer prev; int ours; boolean failSave; final List<String> events;
        FakeStore(List<String> events) { this.events = events; }
        public boolean active() { return active; }
        public Integer prev() { return prev; }
        public int ours() { return ours; }
        public boolean save(Integer p, int o, long at) { events.add("save"); if (failSave) return false; active = true; prev = p; ours = o; return true; }
        public boolean clear() { events.add("clear-state"); active = false; prev = null; ours = 0; return true; }
    }

    static final class FakePanel implements BacklightLogic.Panel {
        int v; boolean failSet; FakePanel(int v) { this.v = v; }
        public Integer get() { return v; }
        public boolean set(int x) { if (failSet) return false; v = x; return true; }
    }
    static final class FakeEco implements BacklightLogic.Store {
        Integer prev, ours; boolean failSave;
        public Integer prev() { return prev; }
        public Integer ours() { return ours; }
        public boolean save(Integer p, Integer o) { if (failSave) return false; prev = p; ours = o; return true; }
    }

    public static void main(String[] a) {
        // --- density: apply then restore, from no override
        {
            FakeDisplay d = new FakeDisplay(null); FakeStore s = new FakeStore(d.calls);
            check("apply from none", DensityLogic.apply(d, s, 240, 1) == DensityLogic.Result.APPLIED && d.override == 240 && s.active && s.prev == null);
            check("state saved before the change", d.calls.indexOf("save") < d.calls.indexOf("set 240"));
            check("restore to none", DensityLogic.restore(d, s) == DensityLogic.Result.RESTORED && d.override == null && !s.active);
            check("restore again is a no-op", DensityLogic.restore(d, s) == DensityLogic.Result.NOTHING_TO_DO && d.override == null);
        }
        // --- an existing override of the owner's is put back exactly
        {
            FakeDisplay d = new FakeDisplay(280); FakeStore s = new FakeStore(d.calls);
            DensityLogic.apply(d, s, 213, 1);
            check("prev records the owner's 280", s.prev != null && s.prev == 280);
            DensityLogic.restore(d, s);
            check("restore puts 280 back", d.override != null && d.override == 280);
        }
        // --- a second open while active never records our own value as "prev"
        {
            FakeDisplay d = new FakeDisplay(null); FakeStore s = new FakeStore(d.calls);
            DensityLogic.apply(d, s, 240, 1);
            DensityLogic.apply(d, s, 213, 2);
            check("double apply keeps the true prev (none)", s.active && s.prev == null && s.ours == 213 && d.override == 213);
            DensityLogic.restore(d, s);
            check("and restores to none", d.override == null);
        }
        // --- crash then reboot: a new display with the low density still forced, same durable store
        {
            List<String> ev = new ArrayList<>();
            FakeStore s = new FakeStore(ev);
            FakeDisplay before = new FakeDisplay(null);
            DensityLogic.apply(before, s, 240, 1);
            FakeDisplay afterBoot = new FakeDisplay(240);              // WindowManager re-applied the forced value at boot
            check("boot restores a stuck density", DensityLogic.restore(afterBoot, s) == DensityLogic.Result.RESTORED && afterBoot.override == null && !s.active);
        }
        // --- someone ran `wm density reset` (or chose another value) meanwhile: we only forget
        {
            FakeDisplay d = new FakeDisplay(null); FakeStore s = new FakeStore(d.calls);
            DensityLogic.apply(d, s, 240, 1);
            d.override = null;
            check("external reset: forget, touch nothing", DensityLogic.restore(d, s) == DensityLogic.Result.FORGOT && d.override == null && !d.calls.contains("clear"));
            DensityLogic.apply(d, s, 240, 2);
            d.override = 300;
            check("external change: keep the owner's 300", DensityLogic.restore(d, s) == DensityLogic.Result.FORGOT && d.override == 300);
        }
        // --- failures
        {
            FakeDisplay d = new FakeDisplay(null); FakeStore s = new FakeStore(d.calls); s.failSave = true;
            check("no durable record, no change", DensityLogic.apply(d, s, 240, 1) == DensityLogic.Result.FAILED && d.override == null && !d.calls.contains("set 240"));
            FakeDisplay d2 = new FakeDisplay(null); FakeStore s2 = new FakeStore(d2.calls); d2.failSet = true;
            check("set fails: state cleared", DensityLogic.apply(d2, s2, 240, 1) == DensityLogic.Result.FAILED && !s2.active);
            FakeDisplay d3 = new FakeDisplay(null); FakeStore s3 = new FakeStore(d3.calls);
            DensityLogic.apply(d3, s3, 240, 1); d3.failClear = true;
            check("restore fails: state kept for the next try", DensityLogic.restore(d3, s3) == DensityLogic.Result.RESTORE_FAILED && s3.active);
            check("apply refuses to stack on a stuck switch", DensityLogic.apply(d3, s3, 213, 2) == DensityLogic.Result.FAILED && d3.override == 240);
            d3.failClear = false;
            check("then the retry works", DensityLogic.restore(d3, s3) == DensityLogic.Result.RESTORED && d3.override == null);
            check("out-of-range dpi refused", DensityLogic.apply(new FakeDisplay(null), new FakeStore(new ArrayList<>()), 40, 1) == DensityLogic.Result.FAILED);
            check("already at target: nothing recorded", DensityLogic.apply(new FakeDisplay(240), s3, 240, 3) == DensityLogic.Result.ALREADY && !s3.active);
        }
        check("parseForced", DensityLogic.parseForced(null) == null && DensityLogic.parseForced("") == null && DensityLogic.parseForced(" 240 ") == 240 && DensityLogic.parseForced("x") == null && DensityLogic.parseForced("0") == null);

        // --- guard: when has Claude left?
        {
            GuardState g = new GuardState("dev.designyourtv", 0);
            check("launcher before Claude appears: wait", !g.onForeground("com.google.android.apps.tv.launcherx", 500));
            check("our tile: neutral", !g.onForeground("dev.designyourtv", 600));
            check("Claude up", !g.onForeground("com.anthropic.claude", 1000) && g.claudeSeen());
            check("keyboard over Claude: neutral", !g.onForeground("com.google.android.inputmethod.latin", 2000));
            check("account picker over Claude: neutral", !g.onForeground("com.google.android.gms", 3000));
            check("unknown foreground: keep going", !g.onForeground(null, 4000));
            check("Home pressed: not yet (grace)", !g.onForeground("com.google.android.apps.tv.launcherx", 10000));
            check("Home for 3 s: restore", g.onForeground("com.google.android.apps.tv.launcherx", 13000));
            GuardState g2 = new GuardState("dev.designyourtv", 0);
            g2.onForeground("com.anthropic.claude", 100);
            g2.onForeground("com.netflix.ninja", 1000);
            check("back to Claude within the grace: no restore", !g2.onForeground("com.anthropic.claude", 2000) && !g2.onForeground("com.netflix.ninja", 4500));
            check("then away for 3 s: restore", g2.onForeground("com.netflix.ninja", 7600));
            GuardState g3 = new GuardState("dev.designyourtv", 0);
            check("Claude never starts: restore after 60 s", !g3.onForeground("com.mitv.tvhome.atv", 59000) && g3.onForeground("com.mitv.tvhome.atv", 60001));
            GuardState g4 = new GuardState("dev.designyourtv", 0);
            check("Claude never starts, foreground unknown: restore after 60 s", !g4.onForeground(null, 1000) && g4.onForeground(null, 61000));
            // Claude up and Home pressed inside one tick: fed in order, Claude still counts as seen
            GuardState g5 = new GuardState("dev.designyourtv", 0);
            g5.onForeground("dev.designyourtv", 300);
            g5.onForeground("com.anthropic.claude", 1100);
            boolean early = g5.onForeground("com.google.android.apps.tv.launcherx", 1300);
            check("Claude seen and left within one tick: restore 3 s later, not after 60 s", !early && g5.claudeSeen() && !g5.onForeground("com.google.android.apps.tv.launcherx", 3000) && g5.onForeground("com.google.android.apps.tv.launcherx", 4400));
        }

        // --- intent links from the dock
        check("Netflix link", IntentPolicy.parse("intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=com.netflix.ninja;end").pkg.equals("com.netflix.ninja"));
        check("Settings link", IntentPolicy.parse("intent:#Intent;action=android.settings.SETTINGS;end").action.equals("android.settings.SETTINGS"));
        check("iQIYI and meWatch links", IntentPolicy.parse("intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=com.iqiyi.i18n.tv;end").pkg.equals("com.iqiyi.i18n.tv")
            && IntentPolicy.parse("intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=sg.mediacorp.android;end").pkg.equals("sg.mediacorp.android"));
        check("All apps and Inputs links", IntentPolicy.parse("intent:#Intent;action=android.intent.action.ALL_APPS;end").action.equals("android.intent.action.ALL_APPS")
            && IntentPolicy.parse("intent:#Intent;action=com.android.tv.action.VIEW_INPUTS;end").action.equals("com.android.tv.action.VIEW_INPUTS"));
        String[] cl = { "claude.ai", "claude.com", "anthropic.com" };
        check("Claude screen: claude.ai and subdomains over HTTPS", WebHosts.allowed("https", "claude.ai", cl, false) && WebHosts.allowed("https", "support.claude.com", cl, false));
        check("Claude screen: plain HTTP and look-alikes refused", !WebHosts.allowed("http", "claude.ai", cl, false) && !WebHosts.allowed("https", "evilclaude.ai", cl, false)
            && !WebHosts.allowed("https", "claude.ai.evil.com", cl, false) && !WebHosts.allowed("https", null, cl, false));
        check("Dashboard: hub over HTTP only", WebHosts.allowed("http", "192.168.1.10", new String[] { "192.168.1.10" }, true) && !WebHosts.allowed("http", "192.168.2.1", new String[] { "192.168.1.10" }, true));
        check("unknown package dropped", IntentPolicy.parse("intent:#Intent;action=android.intent.action.MAIN;package=com.evil.app;end") == null);
        check("component dropped", IntentPolicy.parse("intent:#Intent;component=com.netflix.ninja/.X;package=com.netflix.ninja;end") == null);
        check("extras dropped", IntentPolicy.parse("intent:#Intent;package=com.netflix.ninja;S.browser_fallback_url=http%3A%2F%2Fx;end") == null);
        check("other action dropped", IntentPolicy.parse("intent:#Intent;action=android.intent.action.DELETE;package=com.netflix.ninja;end") == null);
        check("unknown action dropped", IntentPolicy.parse("intent:#Intent;action=android.settings.DEVELOPMENT_SETTINGS;end") == null);
        check("not an intent", IntentPolicy.parse("https://example.com") == null && IntentPolicy.parse(null) == null && IntentPolicy.parse("intent:#Intent;package=com.netflix.ninja") == null);

        // --- the drawer: a listed app opens, an unlisted one still does not
        java.util.Set<String> listed = new java.util.HashSet<>(java.util.Arrays.asList("com.mitv.gallery"));
        String gal = "intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=com.mitv.gallery;end";
        check("drawer app opens when listed", IntentPolicy.parse(gal, listed) != null && IntentPolicy.parse(gal) == null);
        check("drawer: extras still dropped", IntentPolicy.parse("intent:#Intent;package=com.mitv.gallery;S.x=1;end", listed) == null);

        // --- eco backlight
        {
            FakePanel p = new FakePanel(100); FakeEco s = new FakeEco();
            check("eco dims from 100", BacklightLogic.dim(p, s, BacklightLogic.ECO) == BacklightLogic.Result.DIMMED && p.v == 35 && s.prev == 100 && s.ours == 35);
            check("AOD keeps his true 100", BacklightLogic.dim(p, s, BacklightLogic.AOD) == BacklightLogic.Result.DIMMED && p.v == 12 && s.prev == 100);
            check("restore puts 100 back", BacklightLogic.restore(p, s) == BacklightLogic.Result.RESTORED && p.v == 100 && s.prev == null);
            check("restore again: nothing", BacklightLogic.restore(p, s) == BacklightLogic.Result.NOTHING_TO_DO && p.v == 100);
            BacklightLogic.dim(p, s, BacklightLogic.ECO); p.v = 70;                     // he turns it to 70 while dimmed
            check("the owner's own change wins", BacklightLogic.restore(p, s) == BacklightLogic.Result.FORGOT && p.v == 70);
            FakePanel low = new FakePanel(20); FakeEco s2 = new FakeEco();
            check("already darker: untouched", BacklightLogic.dim(low, s2, BacklightLogic.ECO) == BacklightLogic.Result.ALREADY && low.v == 20 && s2.prev == null);
            FakePanel q = new FakePanel(100); FakeEco s3 = new FakeEco(); s3.failSave = true;
            check("no record, no change", BacklightLogic.dim(q, s3, BacklightLogic.ECO) == BacklightLogic.Result.FAILED && q.v == 100);
            FakePanel r = new FakePanel(100); FakeEco s4 = new FakeEco(); BacklightLogic.dim(r, s4, BacklightLogic.ECO); r.failSet = true;
            check("restore fails: record kept", BacklightLogic.restore(r, s4) == BacklightLogic.Result.FAILED && s4.prev == 100);
            r.failSet = false;
            check("then the retry works", BacklightLogic.restore(r, s4) == BacklightLogic.Result.RESTORED && r.v == 100);
            check("AOD after 30 min", BacklightLogic.target(0) == 35 && BacklightLogic.target(29 * 60_000L) == 35 && BacklightLogic.target(30 * 60_000L) == 12);
            check("out of range refused", BacklightLogic.dim(new FakePanel(100), new FakeEco(), 101) == BacklightLogic.Result.FAILED);
        }

        // --- the Home-button service stays switched on
        String svc = "dev.designyourtv/.HomeKeyService";
        check("a11y: empty or null list gets ours", svc.equals(A11yList.with(null, svc)) && svc.equals(A11yList.with("null", svc)) && svc.equals(A11yList.with("", svc)));
        check("a11y: already there (either spelling) writes nothing", A11yList.with(svc, svc) == null
            && A11yList.with("a.b/.X:dev.designyourtv/dev.designyourtv.HomeKeyService", svc) == null);
        check("a11y: others kept, ours appended", ("a.b/.X:" + svc).equals(A11yList.with("a.b/.X", svc)));
        check("a11y without: only ours listed -> null", "null".equals(A11yList.without(svc, svc)) && "null".equals(A11yList.without(null, svc)) && "null".equals(A11yList.without("null", svc)));
        check("a11y without: other services kept in order, either spelling of ours dropped",
            "a.b/.X:c.d/.Y".equals(A11yList.without("a.b/.X:" + svc + ":c.d/.Y", svc))
            && "a.b/.X".equals(A11yList.without("a.b/.X:dev.designyourtv/dev.designyourtv.HomeKeyService", svc)));

        // --- usage-log foreground (HomeKeyService follows Google TV's home only while it is verifiably in front)
        UsageFront uf = new UsageFront();
        check("usage front: nothing known is not front", !uf.known() && !uf.isFront("a", "A") && uf.since() == -1);
        uf.add(10, true, "com.google.android.apps.tv.launcherx", "com.google.android.apps.tv.launcherx.home.HomeActivity");
        check("usage front: the last foreground event wins", uf.isFront("com.google.android.apps.tv.launcherx", "com.google.android.apps.tv.launcherx.home.HomeActivity") && uf.since() == 10);
        uf.add(20, true, "com.google.android.youtube.tv", "com.google.android.apps.youtube.tv.activity.MainActivity");
        check("usage front: an app in front after Google TV's home is not Google TV's home", !uf.isFront("com.google.android.apps.tv.launcherx", "com.google.android.apps.tv.launcherx.home.HomeActivity") && uf.pkg().equals("com.google.android.youtube.tv"));
        uf.add(30, false, "com.google.android.apps.tv.launcherx", "com.google.android.apps.tv.launcherx.home.HomeActivity");
        check("usage front: a background event of something else changes nothing", uf.pkg().equals("com.google.android.youtube.tv"));
        uf.add(40, false, "com.google.android.youtube.tv", "com.google.android.apps.youtube.tv.activity.MainActivity");
        check("usage front: the front component moving to the background leaves nothing known", !uf.known() && !uf.isFront("com.google.android.youtube.tv", "com.google.android.apps.youtube.tv.activity.MainActivity"));
        uf.add(50, true, null, "x"); uf.add(50, false, "x", null);
        check("usage front: null names are ignored", !uf.known());

        // --- per-app brightness (music mid, everything else the owner's level)
        String own = "dev.designyourtv";
        check("app brightness: YouTube Music is at the music level", AppBrightness.levelFor("com.google.android.youtube.tvmusic", own, false) == AppBrightness.MUSIC);
        check("app brightness: Spotify is at the music level", AppBrightness.levelFor("com.spotify.tv.android", own, false) == AppBrightness.MUSIC);
        check("app brightness: YouTube opened by YouTube Music is at the music level", AppBrightness.levelFor(MusicCover.YT, own, true) == AppBrightness.MUSIC);
        check("app brightness: YouTube on its own keeps his level", AppBrightness.levelFor(MusicCover.YT, own, false) == AppBrightness.HIS_LEVEL);
        check("app brightness: Netflix and unknown apps keep his level", AppBrightness.levelFor("com.netflix.ninja", own, false) == AppBrightness.HIS_LEVEL && AppBrightness.levelFor("x.unknown", own, false) == AppBrightness.HIS_LEVEL);
        check("app brightness: a stale music flag does not dim System UI or another app", AppBrightness.levelFor("com.android.systemui", own, true) == AppBrightness.HIS_LEVEL && AppBrightness.levelFor("com.netflix.ninja", own, true) == AppBrightness.HIS_LEVEL);
        check("app brightness: our own screens and empty names say his level (they set their own)", AppBrightness.levelFor(own, own, true) == AppBrightness.HIS_LEVEL && AppBrightness.levelFor(null, own, false) == AppBrightness.HIS_LEVEL && AppBrightness.levelFor("", own, true) == AppBrightness.HIS_LEVEL);

        // --- hub or offline copy
        check("healthy", HubChooser.healthy(200, "{\"ok\": true, \"version\":\"1\"}") && !HubChooser.healthy(200, "{\"ok\":false}") && !HubChooser.healthy(503, "{\"ok\":true}") && !HubChooser.healthy(200, null));
        check("choose", HubChooser.choose(true).equals("http://192.168.1.10:8790/tv-setup.html?kiosk=tv") && HubChooser.choose(false).startsWith("file:///android_asset/offline/"));
        check("mayLoad", HubChooser.mayLoad("http://192.168.1.10:8790/plates/x.webp") && HubChooser.mayLoad("file:///android_asset/offline/index.html")
            && !HubChooser.mayLoad("https://example.com/") && !HubChooser.mayLoad("http://192.168.1.10:8790.evil.com/") && !HubChooser.mayLoad("file:///android_asset/offline/../x")
            && !HubChooser.mayLoad("file:///data/data/x"));
        check("mirror", HubChooser.mayLoad("http://192.168.1.11:8792/plates/x.webp") && !HubChooser.mayLoad("http://192.168.1.11:8792.evil.com/")
            && !HubChooser.mayLoad("http://192.168.1.11:8792/../x") && HubChooser.ours("http://192.168.1.11:8792/plates/a.plate.webp")
            && !HubChooser.ours("http://192.168.1.11:8793/x") && !HubChooser.ours(null));
        check("pageFrom", HubChooser.pageFrom(HubChooser.MIRROR).equals("http://192.168.1.11:8792/tv-setup.html?kiosk=tv")
            && HubChooser.pageFrom(HubChooser.HUB).equals(HubChooser.PAGE) && HubChooser.pageFrom(null).equals(HubChooser.OFFLINE)
            && HubChooser.ORIGINS[0].equals(HubChooser.HUB));
        {
            String H = HubChooser.HUB, M = HubChooser.MIRROR;
            HubChooser.Sticky s = new HubChooser.Sticky();
            check("sticky: first check moves at once", H.equals(s.next(H)) && !s.pending());
            check("sticky: one missed hub check stays on the hub", H.equals(s.next(M)) && s.pending());
            check("sticky: two misses still stay", H.equals(s.next(null)));
            check("sticky: a hub answer resets the misses", H.equals(s.next(H)) && !s.pending() && H.equals(s.next(M)) && H.equals(s.next(M)));
            check("sticky: the third miss in a row moves to the POCO", M.equals(s.next(M)) && !s.pending());
            check("sticky: one hub answer is not enough to go back", M.equals(s.next(H)) && s.pending());
            check("sticky: a POCO-only check in between resets it", M.equals(s.next(M)) && M.equals(s.next(H)));
            check("sticky: two hub answers in a row go back", H.equals(s.next(H)));
            HubChooser.Sticky o = new HubChooser.Sticky();
            check("sticky: nothing up at start: the built-in copy", o.next(null) == null);
            check("sticky: from the built-in copy, the first answer is taken at once", M.equals(o.next(M)));
            check("sticky: the POCO's three misses go to the built-in copy", M.equals(o.next(null)) && M.equals(o.next(null)) && o.next(null) == null);
            HubChooser.Sticky seeded = new HubChooser.Sticky();
            seeded.seed(H);
            check("sticky: seeded hub holds across a single missed check", H.equals(seeded.next(M)) && seeded.pending());
            HubChooser.Sticky seededM = new HubChooser.Sticky();
            seededM.seed(M);
            check("sticky: seeded mirror waits for two hub checks", M.equals(seededM.next(H)) && seededM.pending() && H.equals(seededM.next(H)));
            HubChooser.Sticky down = new HubChooser.Sticky();
            down.seed(H);
            down.reset();
            check("sticky: seeded origin is down: move on the first check", M.equals(down.next(M)));
        }

        // --- YouTube Music keeps playing: Home draws the wallpaper over the player instead of leaving it
        {
            String me = "dev.designyourtv", yt = MusicCover.YT, ytm = MusicCover.YTM;
            check("music playing: Home covers", MusicCover.onHome(false, yt, true, true, false) == MusicCover.Home.SHOW_COVER);
            check("cover up: Home uncovers", MusicCover.onHome(true, yt, true, true, false) == MusicCover.Home.HIDE_COVER);
            check("plain YouTube video: Home leaves", MusicCover.onHome(false, yt, false, true, false) == MusicCover.Home.OPEN_WALL);
            check("music paused: Home leaves", MusicCover.onHome(false, yt, true, false, false) == MusicCover.Home.OPEN_WALL);
            check("wallpaper in front: Google TV", MusicCover.onHome(false, me, true, true, true) == MusicCover.Home.OPEN_GOOGLE_TV);
            check("Netflix with sound: Home leaves", MusicCover.onHome(false, "com.netflix.ninja", true, true, false) == MusicCover.Home.OPEN_WALL);
            boolean m = MusicCover.musicModeAfter(false, ytm, me);
            m = MusicCover.musicModeAfter(m, yt, me);
            check("YT Music hands to YouTube: still music", m);
            check("our cover and System UI keep it", MusicCover.musicModeAfter(MusicCover.musicModeAfter(m, me, me), "com.android.systemui", me));
            check("another app ends it", !MusicCover.musicModeAfter(m, "com.netflix.ninja", me) && !MusicCover.musicModeAfter(m, "com.google.android.apps.tv.launcherx", me));
            check("YouTube opened alone is not music", !MusicCover.musicModeAfter(false, yt, me));
            check("cover kept over YouTube, dropped for Netflix", MusicCover.keepCover(yt, "x.MainActivity", me) && MusicCover.keepCover(me, me + ".HomeActivity", me)
                && !MusicCover.keepCover("com.netflix.ninja", "x.Main", me));
            check("the screensaver ends the cover", !MusicCover.keepCover(me, MusicCover.DREAM, me));
            check("keys: D-pad and OK to the page, media keys pass", "ArrowLeft".equals(MusicCover.pageKey(21)) && "Enter".equals(MusicCover.pageKey(23))
                && MusicCover.pageKey(85) == null && MusicCover.pageKey(24) == null && MusicCover.isBack(4) && !MusicCover.isBack(85) && MusicCover.isChannel(166));
        }

        System.out.println(failed == 0 ? "all " + run + " passed" : failed + " of " + run + " failed");
        System.exit(failed == 0 ? 0 : 1);
    }
}
