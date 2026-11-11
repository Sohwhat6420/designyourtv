#!/usr/bin/env node
// fake-adb.mjs: a stand-in for adb.exe that answers like a Xiaomi Android TV, for testing tv-apply.mjs and the runbook
// offline. Run as `node tools/test/fake-adb.mjs <adb args>` (tv-apply.mjs does this itself for a --adb path ending in
// .mjs), or through the sh wrapper tools/test/fake-adb for the runbook's raw "$ADB" lines.
//
// Environment:
//   FAKE_ADB_STATE    JSON file holding the fake devices' state and the call log (required)
//   FAKE_TV_PROFILE   gtv14 (Google TV 14, SDK 34, arm64, the SG A Pro 2026 shape) | patchwall11 (PatchWall on
//                     Android TV 11, SDK 30, 32-bit only, old WebView)   used when the state file is created
//   FAKE_TV_SERIAL    the TV's ip:port (default 192.168.1.123:5555)
//   FAKE_UNDO_DIR     where tv-undo-*.json logs live: every forward change must already be in a log, status pending
//
// It also lists the POCO (192.168.1.78:5555), the S24 (mDNS name) and a "phone on a TV-like address"
// (192.168.1.124:5555). Any call that names a phone, any forbidden verb (kill-server, pm clear, a full uninstall of a
// system app, a Play Store update uninstall), any change to a protected package and any change that was not logged
// first is written to state.violations. The tests fail on any violation.
import fs from "node:fs";
import path from "node:path";

const STATE = process.env.FAKE_ADB_STATE;
if (!STATE) { process.stderr.write("fake-adb: set FAKE_ADB_STATE\n"); process.exit(1); }
const TV = process.env.FAKE_TV_SERIAL || "192.168.1.123:5555";
const POCO = "192.168.1.78:5555", S24 = "adb-R5TEST00000-Xy12Ab._adb-tls-connect._tcp", TRAP = "192.168.1.124:5555";
const PHONES = [POCO, S24, TRAP];

// The fake's own never-touch list, written from the owner's asks, independent of tv-apply.mjs's list.
const PROTECTED = [
  "com.android.tv.settings", "com.xiaomi.mitv.settings", "com.android.systemui", "android",
  "com.mitv.livetv", "com.mediatek.tvinput", "com.google.android.tv", "com.android.providers.tv",
  "com.android.bluetooth", "com.mi.bluetooth",
  "com.google.android.apps.mediashell", "com.google.android.tv.remote.service", "mitv.service",
  "com.xiaomi.mitv.smartshare", "com.xiaomi.wfdsinkhelperservice", "com.mitv.milinkservice",
  "com.android.vending", "com.google.android.gms", "com.google.android.gsf",
  "com.google.android.inputmethod.latin", "com.google.android.leanback.ime", "com.google.android.webview",
];
const LAUNCHERS = ["com.mitv.tvhome.atv", "com.mitv.tvhome", "com.google.android.apps.tv.launcherx", "com.google.android.tvlauncher"];

function sysPkgs(list) { return Object.fromEntries(list.map(p => [p, { enabled: true, user: true, system: true, version: 100 }])); }
function newState(profile) {
  const common = [
    "android", "com.android.systemui", "com.android.tv.settings", "com.android.vending", "com.google.android.gms", "com.google.android.gsf",
    "com.google.android.webview", "com.google.android.apps.mediashell", "com.google.android.tv.remote.service", "com.android.bluetooth",
    "com.mi.bluetooth", "mitv.service", "com.mitv.livetv", "com.mediatek.tvinput", "com.android.providers.tv", "com.google.android.tv",
    "com.xiaomi.mitv.smartshare", "com.xiaomi.wfdsinkhelperservice", "com.mitv.milinkservice", "com.xiaomi.mitv.settings",
    "com.netflix.ninja", "com.google.android.youtube.tv", "com.google.android.youtube.tvmusic", "com.amazon.amazonvideo.livingroom",
    "com.spotify.tv.android", "com.xiaomi.mitv.updateservice",
    // bloat the list knows
    "com.miui.tv.analytics", "com.xiaomi.statistic", "com.google.android.feedback", "com.xiaomi.mitv.tvmanager", "com.google.android.play.games",
    "com.mitv.tvhome.michannel", "com.mitv.tvhome.mitvplus", "android.autoinstalls.config.xiaomi.amelie", "com.google.android.tv.bugreportsender",
    "fusion.android.tv.demo", "com.xm.webcontent", "com.mitv.gallery", "com.xiaomi.mitv.mediaexplorer", "com.xiaomi.mimusic2",
    "com.android.dreams.basic", "com.google.android.tvrecommendations", "com.google.android.katniss", "com.xiaomi.mitv.handbook",
    "com.android.printspooler", "com.google.android.videos",
    // things the list does not know (must be reported, never touched)
    "com.xiaomi.tvqs.overseas", "com.xiaomi.mitv.mysteryservice", "com.mediatek.unknownhelper",
  ];
  const g = profile === "gtv14";
  const pkgs = sysPkgs([...common, ...(g
    ? ["com.google.android.apps.tv.launcherx", "com.google.android.tungsten.setupwraith", "com.google.android.apps.tv.dreamx", "com.google.android.inputmethod.latin", "com.mitv.tvhome.oemtab"]
    : ["com.mitv.tvhome.atv", "com.mitv.dream", "com.google.android.leanback.ime", "com.google.android.backdrop", "com.xiaomi.tweather"])]);
  pkgs["com.netflix.ninja"].system = false;
  pkgs["com.spotify.tv.android"].system = false;
  return {
    profile, connected: { [TV]: false }, reboots: 0, foreground: null, calls: [], violations: [], unknown: [],
    tv: {
      props: g ? {
        "ro.product.manufacturer": "Xiaomi", "ro.product.brand": "Xiaomi", "ro.product.model": "MiTV-MZTU0", "ro.product.device": "mztu0",
        "ro.build.version.release": "14", "ro.build.version.sdk": "34", "ro.product.cpu.abilist": "arm64-v8a,armeabi-v7a,armeabi",
        "ro.build.characteristics": "tv", "ro.build.fingerprint": "Xiaomi/mztu0/mztu0:14/UTT3.240625.001/1234:user/release-keys",
        "ro.adb.secure": "1", "ro.serialno": "MZTU0SG000123", "ro.config.low_ram": "false",
      } : {
        "ro.product.manufacturer": "Xiaomi", "ro.product.brand": "Xiaomi", "ro.product.model": "MiTV-AXSO0", "ro.product.device": "axso0",
        "ro.build.version.release": "11", "ro.build.version.sdk": "30", "ro.product.cpu.abilist": "armeabi-v7a,armeabi",
        "ro.build.characteristics": "tv", "ro.build.fingerprint": "Xiaomi/axso0/axso0:11/RTT0.211019.001/5678:user/release-keys",
        "ro.adb.secure": "1", "ro.serialno": "AXSO0AA000456", "ro.config.low_ram": "true",
      },
      leanback: true, pkgs,
      settings: {
        global: { window_animation_scale: "1.0", transition_animation_scale: "1.0", animator_duration_scale: "1.0" },
        secure: {
          default_input_method: g ? "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME" : "com.google.android.leanback.ime/.LeanbackImeService",
          enabled_input_methods: g ? "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME" : "com.google.android.leanback.ime/.LeanbackImeService",
          screensaver_components: g ? "com.google.android.apps.tv.dreamx/.service.Backdrop" : "com.mitv.dream/.MiDream",
          screensaver_enabled: "1", sleep_timeout: "14400000",
        },
        system: { screen_off_timeout: "1800000" },
      },
      home: g ? "com.google.android.apps.tv.launcherx/com.google.android.apps.tv.launcherx.home.HomeActivity" : "com.mitv.tvhome.atv/com.mitv.tvhome.TvHomeActivity",
      wifiOwner: g ? "com.google.android.tungsten.setupwraith" : "android.uid.system:1000",
      webview: g ? "130.0.6723.102" : "95.0.4638.74",
      density: { physical: 320, override: null }, size: "1920x1080",
      appops: {}, grants: {},
    },
  };
}

const load = () => {
  if (!fs.existsSync(STATE)) { const s = newState(process.env.FAKE_TV_PROFILE || "gtv14"); fs.writeFileSync(STATE, JSON.stringify(s, null, 1)); return s; }
  return JSON.parse(fs.readFileSync(STATE, "utf8"));
};
const st = load();
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
const args = process.argv.slice(2);
st.calls.push(args);
const violate = why => st.violations.push({ why, args });
const out = (stdout, code = 0, stderr = "") => { save(); if (stdout) process.stdout.write(stdout); if (stderr) process.stderr.write(stderr); process.exit(code); };

/* ---------- the write-ahead check ---------- */
function logEntries() {
  const dir = process.env.FAKE_UNDO_DIR;
  if (!dir || !fs.existsSync(dir)) return [];
  const all = [];
  for (const f of fs.readdirSync(dir).filter(f => /^tv-undo-.*\.json$/.test(f))) {
    try { all.push(...(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).entries || [])); } catch { /* half-written: the tool renames atomically */ }
  }
  return all;
}
/** forward: a pending entry must describe it. reverse: a done, not-undone entry must be the one it reverses. */
function mustBeLogged(kind, match) {
  const es = logEntries();
  const pending = es.some(e => e.status === "pending" && match(e, "forward"));
  const reversing = es.some(e => e.status !== "failed" && !e.undoneAt && match(e, "reverse"));
  if (!pending && !reversing) violate(`${kind} was not in an undo log before it was sent`);
}
function protectedTouch(pkg, verb) {
  if (PROTECTED.includes(pkg)) violate(`${verb} on protected ${pkg}`);
  if (LAUNCHERS.includes(pkg) && verb !== "enable") violate(`${verb} on a stock launcher ${pkg} (no replacement in this test)`);
}

/* ---------- top-level verbs ---------- */
const verb = args[0];
if (verb === "version") out("Android Debug Bridge version 1.0.41\nVersion 36.0.0-fake\nInstalled as fake-adb.mjs\n");
if (verb === "kill-server" || verb === "start-server") { violate(`adb ${verb}`); out("", 1, "fake-adb: kill-server is forbidden here\n"); }
if (verb === "devices") {
  const lines = ["List of devices attached"];
  if (st.connected[TV]) lines.push(`${TV}\tdevice product:${st.tv.props["ro.product.device"]} model:${st.tv.props["ro.product.model"]} device:${st.tv.props["ro.product.device"]} transport_id:7`);
  lines.push(`${POCO}\tdevice product:duchamp_global model:2311DRK48G device:duchamp transport_id:3`);
  lines.push(`${S24}\tdevice product:e3qxeea model:SM_S928B device:e3q transport_id:4`);
  lines.push(`${TRAP}\tdevice product:duchamp_global model:2311DRK48G device:duchamp transport_id:5`);
  out(lines.join("\n") + "\n\n");
}
if (verb === "connect") {
  const t = args[1];
  if (PHONES.includes(t)) { violate(`connect to a phone ${t}`); out(`already connected to ${t}\n`); }
  if (t !== TV) out(`failed to connect to '${t}': Connection refused\n`, 1);
  const was = st.connected[TV]; st.connected[TV] = true;
  out(was ? `already connected to ${TV}\n` : `connected to ${TV}\n`);
}
if (verb === "disconnect") { st.connected[TV] = false; out(`disconnected ${TV}\n`); }
if (verb === "pair" || verb === "tcpip" || verb === "root" || verb === "remount") { violate(`adb ${verb}`); out("", 1, "forbidden\n"); }
if (verb !== "-s") { st.unknown.push(args.join(" ")); out("", 1, `fake-adb: unsupported ${args.join(" ")}\n`); }

const serial = args[1], sub = args[2], rest = args.slice(3);
if (PHONES.includes(serial)) {
  // the trap device answers reads (so the identity check can refuse it), but any change to it is a violation
  if (serial !== TRAP || /^(install|uninstall|reboot)/.test(sub) || /^(pm (disable|enable|uninstall|grant|revoke)|settings (put|delete)|wm density \d|appops set|cmd package install)/.test(rest.join(" "))) violate(`touched phone ${serial}: ${sub} ${rest.join(" ")}`);
  if (serial === TRAP && sub === "shell") {
    const c = rest.join(" ");
    const props = { "ro.product.model": "2311DRK48G", "ro.product.device": "duchamp", "ro.serialno": "ZTTEST0000000000", "ro.product.manufacturer": "Xiaomi", "ro.build.characteristics": "default", "ro.build.version.sdk": "35" };
    let m;
    if ((m = /^getprop (\S+)$/.exec(c))) out((props[m[1]] ?? "") + "\n");
    if (c === "pm has-feature android.software.leanback") out("false\n");
  }
  out("", 1, "fake-adb: phone\n");
}
if (serial !== TV) out("", 1, `adb: device '${serial}' not found\n`);
if (!st.connected[TV]) out("", 1, `adb: device '${serial}' not found\n`);

const tv = st.tv;
const P = tv.pkgs;
const isOn = p => P[p] && P[p].user && P[p].enabled;

/* ---------- binary / install verbs ---------- */
if (sub === "exec-out" && rest.join(" ") === "screencap -p") {
  // a real 1x1 PNG
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
  save(); process.stdout.write(png); process.exit(0);
}
if (sub === "reboot") { st.reboots++; st.connected[TV] = false; st.foreground = null; tileRestore(); /* our BootReceiver */ out(""); }
if (sub === "wait-for-device") out("");
if (sub === "install" || sub === "install-multiple") {
  const files = rest.filter(a => !a.startsWith("-"));
  const isClaude = files.some(f => /claude|com\.anthropic/i.test(f) || /split_config/.test(f));
  const pkg = isClaude ? "com.anthropic.claude" : /designyourtv/.test(files.join(" ")) ? "dev.designyourtv" : null;
  if (!pkg) { violate(`install of unknown files ${files.join(" ")}`); out("", 1, "Failure [INSTALL_FAILED_INVALID_APK]\n"); }
  for (const f of files) if (!fs.existsSync(f)) out("", 1, `adb: failed to stat ${f}: No such file or directory\n`);
  mustBeLogged(`install ${pkg}`, (e, dir) => dir === "forward" && e.action === "install" && e.pkg === pkg);
  const sdk = Number(tv.props["ro.build.version.sdk"]);
  const abis = tv.props["ro.product.cpu.abilist"].split(",");
  if (pkg === "com.anthropic.claude") {
    if (sdk < 32) out("", 1, `Failure [INSTALL_FAILED_OLDER_SDK: Failed parse during installPackageLI: /data/app/vmdl123.tmp/base.apk (at Binary XML file line #7): Requires newer sdk version #32 (current version is #${sdk})]\n`);
    if (files.some(f => /arm64_v8a/.test(f)) && !abis.includes("arm64-v8a")) out("", 1, "Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113]\n");
    if (!files.some(f => /base\.apk$/.test(f))) out("", 1, "Failure [INSTALL_FAILED_MISSING_SPLIT]\n");
  }
  P[pkg] = { enabled: true, user: true, system: false, version: pkg === "com.anthropic.claude" ? 26103019 : 1, splits: files.map(f => path.basename(f)) };
  out("Success\n");
}
if (sub === "uninstall") {
  const pkg = rest[rest.length - 1];
  if (!P[pkg]) out("Failure [DELETE_FAILED_INTERNAL_ERROR]\n", 1);
  if (P[pkg].system) { violate(`full uninstall of a system package ${pkg}`); out("Failure [DELETE_FAILED_INTERNAL_ERROR]\n", 1); }
  mustBeLogged(`uninstall ${pkg}`, (e, dir) => dir === "reverse" && e.action === "install" && e.pkg === pkg);
  if (pkg === "dev.designyourtv" && tv.tile && tv.tile.saved && tv.density.override === tv.tile.saved.dpi)
    violate(`our APK uninstalled while its Claude tile still holds the density at ${tv.density.override} (the TV would stay small)`);
  delete P[pkg]; delete tv.grants[pkg]; delete tv.appops[pkg];
  if (pkg === "dev.designyourtv") delete tv.tile;
  out("Success\n");
}
if (sub !== "shell") { st.unknown.push(args.join(" ")); out("", 1, `fake-adb: unsupported ${sub}\n`); }

/* ---------- shell ---------- */
const c = rest.join(" ").trim();
let m;
// forbidden, whatever the tool thinks
if (/\bpm\s+clear\b|\bcmd\s+package\s+clear\b/.test(c)) { violate(`data wipe: ${c}`); out("", 1, "forbidden\n"); }
if (/uninstall-system-updates/.test(c) || (/\bpm\s+uninstall\b/.test(c) && !/pm uninstall -k --user 0 \S+$/.test(c))) { violate(`irreversible uninstall: ${c}`); out("", 1, "forbidden\n"); }
if (/\breboot\b|\bsetprop\b|\bsu\b|\brm\s/.test(c)) { violate(`forbidden shell: ${c}`); out("", 1, "forbidden\n"); }

const listPkgs = flags => {
  const f = new Set(flags.split(/\s+/).filter(Boolean));
  return Object.entries(P).filter(([, v]) => (f.has("-u") || v.user))
    .filter(([, v]) => !f.has("-d") || !v.enabled).filter(([, v]) => !f.has("-e") || v.enabled)
    .filter(([, v]) => !f.has("-3") || !v.system).filter(([, v]) => !f.has("-s") || v.system)
    .map(([p, v]) => `package:${f.has("-f") ? `/system/app/${p}/${p}.apk=` : ""}${p}${f.has("--show-versioncode") ? ` versionCode:${v.version}` : ""}`).sort().join("\n") + "\n";
};
const homeNow = () => {
  if (st.tv.preferredHome && isOn(st.tv.preferredHome.split("/")[0])) return st.tv.preferredHome;
  const order = [tv.home, "dev.designyourtv/dev.designyourtv.HomeAlias"];
  for (const h of order) if (isOn(h.split("/")[0]) && (h.split("/")[0] !== "dev.designyourtv" || tv.homeAliasOn)) return h;
  if (isOn("com.google.android.tungsten.setupwraith")) return "com.google.android.tungsten.setupwraith/.RecoveryActivity";
  return "com.android.tv.settings/.FallbackHome";
};
const memAvailKB = () => {
  const bloat = ["com.miui.tv.analytics", "com.xiaomi.statistic", "com.google.android.feedback", "com.xiaomi.mitv.tvmanager", "com.google.android.play.games",
    "com.mitv.tvhome.michannel", "com.mitv.tvhome.mitvplus", "com.xm.webcontent", "com.google.android.tv.bugreportsender", "fusion.android.tv.demo", "com.xiaomi.mitv.handbook"];
  return 640000 + 32000 * bloat.filter(p => P[p] && (!P[p].enabled || !P[p].user)).length;
};

if (c === "getprop sys.boot_completed") out("1\n");          // reachable at all means booted, in this fake
if ((m = /^getprop (\S+)$/.exec(c))) out((tv.props[m[1]] ?? "") + "\n");
if (c === "getprop") out(Object.entries(tv.props).map(([k, v]) => `[${k}]: [${v}]`).join("\n") + "\n");
if ((m = /^pm has-feature (\S+)$/.exec(c))) out(m[1] === "android.software.leanback" && tv.leanback ? "true\n" : "false\n");
if (c === "pm list features") out("feature:android.software.leanback\nfeature:android.software.live_tv\nfeature:android.hardware.type.television\n");
if ((m = /^pm list packages(.*?)(?: --user 0)?$/.exec(c))) out(listPkgs(m[1]));
if ((m = /^pm path (\S+)$/.exec(c))) out(P[m[1]] ? `package:/data/app/~~x/${m[1]}-y/base.apk\n` : "", P[m[1]] ? 0 : 1);
if (c.startsWith("cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME")) out(`priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\n${homeNow()}\n`);
if (c.startsWith("cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.HOME")) {
  const claims = [tv.home, "com.google.android.tungsten.setupwraith/.RecoveryActivity", "com.android.tv.settings/.FallbackHome", ...(tv.homeAliasOn ? ["dev.designyourtv/dev.designyourtv.HomeAlias"] : [])];
  out(claims.filter(h => isOn(h.split("/")[0])).map(h => `priority=0 preferredOrder=0\n${h}`).join("\n") + "\n");
}
if ((m = /^settings get (global|secure|system) (\S+)$/.exec(c))) out((tv.settings[m[1]][m[2]] ?? "null") + "\n");
if ((m = /^settings list (global|secure|system)$/.exec(c))) out(Object.entries(tv.settings[m[1]]).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
if ((m = /^settings put (global|secure|system) (\S+) (\S+)$/.exec(c))) {
  const [, ns, key, val] = m;
  mustBeLogged(`settings put ${ns} ${key}`, (e, dir) => e.action === "setting" && e.ns === ns && e.key === key && (dir === "forward" ? e.value === val : e.old === val));
  tv.settings[ns][key] = val; out("");
}
if ((m = /^settings delete (global|secure|system) (\S+)$/.exec(c))) {
  mustBeLogged(`settings delete ${m[2]}`, (e, dir) => dir === "reverse" && e.action === "setting" && e.key === m[2] && e.old === null);
  delete tv.settings[m[1]][m[2]]; out("Deleted 1 rows\n");
}
if (c === "dumpsys webviewupdate") out(`Current WebView package (name, version): (com.google.android.webview, ${tv.webview})\nWebView packages:\n  Valid package com.google.android.webview (versionName: ${tv.webview}) is installed/enabled for all users\n`);
if (c === "dumpsys wifi") out(`Wi-Fi is enabled\n  WifiConfiguration: ID: 0 SSID: "home" ... cname=${tv.wifiOwner} ...\n`);
if ((m = /^dumpsys package (\S+)$/.exec(c))) {
  const p = m[1], v = P[p];
  if (!v || !v.user) out("Unable to find package: " + p + "\n");
  let t = `Packages:\n  Package [${p}] (a1b2c3):\n    userId=10${Object.keys(P).indexOf(p)}\n    versionCode=${v.version}\n    versionName=${p === "com.anthropic.claude" ? "1.261030.19" : "1.0"}\n`;
  if (v.splits) t += `    splits=[${v.splits.join(", ")}]\n`;
  if (p === "com.mediatek.tvinput" || p === "com.mitv.livetv") t += "    Service: android.media.tv.TvInputService\n    requested permissions:\n      android.permission.TV_INPUT_HARDWARE\n";
  t += `    User 0: installed=true enabled=${v.enabled ? 1 : 3}\n`;
  for (const perm of Object.keys(tv.grants[p] || {})) t += `    install permissions:\n      ${perm}: granted=${tv.grants[p][perm]}\n`;
  out(t);
}
if (c === "dumpsys dreams") out(`DreamManager:\n  mCurrentDream=null\n  screensaver_components=${tv.settings.secure.screensaver_components}\n`);
if (c === "dumpsys display") out(`DISPLAY MANAGER (dumpsys display)\n  mDefaultDisplay: 1920 x 1080, 60.0 fps, density ${tv.density.override || tv.density.physical}\n`);
if (c === "dumpsys meminfo") out(`Total RAM: 2,000,000K\n Free RAM: ${memAvailKB()}K\n`);
if (c === "dumpsys media_session") out("MEDIA SESSION SERVICE (dumpsys media_session)\n  Sessions Stack - have 0 sessions:\n");
if (c === 'dumpsys power | grep -m1 mWakefulness=; dumpsys activity activities | grep -E "mResumedActivity|mFocusedApp"') out(`mWakefulness=Awake
  mResumedActivity: ActivityRecord{abc u0 ${st.foreground || homeNow()} t12}
  mFocusedApp=ActivityRecord{abd u0 ${st.foreground || homeNow()} t12}
`);
if (c === "dumpsys activity activities") out(`  mResumedActivity: ActivityRecord{abc u0 ${st.foreground || homeNow()} t12}\n`);
if ((m = /^dumpsys gfxinfo (\S+)$/.exec(c))) out(P[m[1]] ? `Applications Graphics Acceleration Info:\n** Graphics info for pid 4242 [${m[1]}] **\nTotal frames rendered: 7200\nJanky frames: 144 (2.00%)\n` : `No process found for: ${m[1]}\n`);
if (c === "wm size") out(`Physical size: ${tv.size}\n`);
if (c === "wm density") out(`Physical density: ${tv.density.physical}\n${tv.density.override ? `Override density: ${tv.density.override}\n` : ""}`);
if ((m = /^wm density (\d+|reset)$/.exec(c))) {
  const val = m[1] === "reset" ? null : Number(m[1]);
  mustBeLogged(`wm density ${m[1]}`, (e, dir) => e.action === "density" && (dir === "forward" ? e.value === val : e.old === val));
  tv.density.override = val; out("");
}
if (c === "cat /proc/meminfo") out(`MemTotal:        2000000 kB\nMemFree:          120000 kB\nMemAvailable:     ${memAvailKB()} kB\nCached:           500000 kB\n`);
if (c === "df -h /data") out("Filesystem      Size  Used Avail Use% Mounted on\n/dev/block/dm-6  9.5G  5.7G  3.8G  60% /data\n");
if (c === "df -k /data") out("Filesystem     1K-blocks    Used Available Use% Mounted on\n/dev/block/dm-6  10000000 6000000   4000000  60% /data\n");
if (c === "ps -A") {
  const n = 120 + Object.values(P).filter(v => v.user && v.enabled).length;
  out("USER PID PPID VSZ RSS WCHAN ADDR S NAME\n" + Array.from({ length: n }, (_, i) => `u0_a${i} ${1000 + i} 1 0 0 0 0 S proc${i}`).join("\n") + "\n");
}
if (c === "top -b -n 1") out("Tasks: 200 total\n  PID USER PR NI VIRT RES SHR S %CPU %MEM TIME+ ARGS\n");
if (c === "ime list -s") out(tv.settings.secure.default_input_method + "\n");
if ((m = /^pm disable-user --user 0 (\S+)$/.exec(c))) {
  const p = m[1];
  if (!P[p]) out("", 1, `Error: Unknown package: ${p}\n`);
  protectedTouch(p, "disable");
  mustBeLogged(`disable ${p}`, (e, dir) => dir === "forward" && e.action === "disable-user" && e.pkg === p);
  P[p].enabled = false; out(`Package ${p} new state: disabled-user\n`);
}
if ((m = /^pm enable --user 0 (\S+)$/.exec(c))) {
  const p = m[1];
  if (!P[p]) out("", 1, `Error: Unknown package: ${p}\n`);
  mustBeLogged(`enable ${p}`, (e, dir) => (dir === "reverse" && e.action === "disable-user" && e.pkg === p) || (dir === "forward" && e.action === "rollback-enable" && e.pkg === p));
  P[p].enabled = true; out(`Package ${p} new state: enabled\n`);
}
if ((m = /^pm uninstall -k --user 0 (\S+)$/.exec(c))) {
  const p = m[1];
  if (!P[p]) out("Failure [not installed for 0]\n", 1);
  protectedTouch(p, "uninstall");
  mustBeLogged(`uninstall -k ${p}`, (e, dir) => dir === "forward" && e.action === "uninstall-user" && e.pkg === p);
  P[p].user = false; out("Success\n");
}
if ((m = /^cmd package install-existing --user 0 (\S+)$/.exec(c))) {
  const p = m[1];
  if (!P[p]) out("", 1, `Package ${p} doesn't exist\n`);
  mustBeLogged(`install-existing ${p}`, (e, dir) => dir === "reverse" && e.action === "uninstall-user" && e.pkg === p);
  P[p].user = true; out(`Package ${p} installed for user: 0\n`);
}
if ((m = /^pm (grant|revoke) (\S+) (\S+)$/.exec(c))) {
  const [, v, p, perm] = m;
  if (!P[p]) out("", 1, `Unknown package: ${p}\n`);
  if (P[p].system) violate(`${v} on a system package ${p}`);
  mustBeLogged(`${v} ${perm}`, (e, dir) => e.action === "grant" && e.pkg === p && e.perm === perm && (dir === "forward") === (v === "grant"));
  tv.grants[p] = tv.grants[p] || {};
  if (v === "grant") tv.grants[p][perm] = true; else delete tv.grants[p][perm];
  if (!Object.keys(tv.grants[p]).length) delete tv.grants[p];
  out("");
}
if ((m = /^appops get (\S+) (\S+)$/.exec(c))) out(`${m[2]}: ${(tv.appops[m[1]] || {})[m[2]] || "default"}\n`);
if ((m = /^appops set (\S+) (\S+) (\S+)$/.exec(c))) {
  const [, p, op, mode] = m;
  mustBeLogged(`appops ${op}`, (e, dir) => e.action === "appops" && e.pkg === p && e.op === op && (dir === "forward" ? e.value === mode : e.old === mode));
  tv.appops[p] = tv.appops[p] || {};
  if (mode === "default") delete tv.appops[p][op]; else tv.appops[p][op] = mode;
  if (!Object.keys(tv.appops[p]).length) delete tv.appops[p];
  out("");
}
// our Claude tile, as tools/tv-dream/src/.../core/DensityLogic.java behaves: restore first, save before switching,
// never overwrite a density someone else set, and the guard restores on Home
function tileRestore() {
  const t = tv.tile;
  if (t && t.saved) { if (tv.density.override === t.saved.dpi) tv.density.override = t.saved.prev; t.saved = null; }
}
if ((m = /^am start -W --activity-clear-task -n dev\.designyourtv\/\.ClaudeTile(?: --ei dpi (\d+)| (--ez restore true))?$/.exec(c))) {
  if (!isOn("dev.designyourtv")) out("Starting: Intent { cmp=dev.designyourtv/.ClaudeTile }\nError type 3\nError: Activity class {dev.designyourtv/dev.designyourtv.ClaudeTile} does not exist.\n", 0);
  const t = tv.tile = tv.tile || { dpi: 240, saved: null };
  tileRestore();
  if (m[2]) out("Starting: Intent { cmp=dev.designyourtv/.ClaudeTile (has extras) }\nStatus: ok\nActivity: dev.designyourtv/.ClaudeTile\n");
  if (m[1]) t.dpi = Number(m[1]);
  const canWrite = !!(tv.grants["dev.designyourtv"] || {})["android.permission.WRITE_SECURE_SETTINGS"];
  if (isOn("com.anthropic.claude")) {
    if (canWrite && tv.density.override !== t.dpi) { t.saved = { dpi: t.dpi, prev: tv.density.override }; tv.density.override = t.dpi; }
    st.foreground = "com.anthropic.claude/.mainactivity.MainActivity";
  }
  out("Starting: Intent { cmp=dev.designyourtv/.ClaudeTile (has extras) }\nStatus: ok\nActivity: " + (st.foreground || "dev.designyourtv/.ClaudeTile") + "\n");
}
if ((m = /^am start -n (\S+)$/.exec(c))) {
  const p = m[1].split("/")[0];
  if (!isOn(p)) out(`Starting: Intent { cmp=${m[1]} }\nError type 3\nError: Activity class {${m[1]}} does not exist.\n`, 0);
  st.foreground = m[1]; out(`Starting: Intent { cmp=${m[1]} }\n`);
}
if (c === "cmd package bg-dexopt-job") out("Success\n");
if ((m = /^input keyevent (\S+)$/.exec(c))) { if (/HOME|3/.test(m[1])) { st.foreground = null; tileRestore(); } out(""); }
st.unknown.push(c);
out("", 127, `/system/bin/sh: ${c.split(" ")[0]}: not found (fake-adb has no answer for "${c}")\n`);
