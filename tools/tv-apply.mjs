#!/usr/bin/env node
// tv-apply.mjs: debloat, tune and set up the TV (Xiaomi Android / Google TV) over network adb, reversibly.
// Zero dependencies. The README's "Put it on the TV" walks through it.
//
//   T="node tools/tv-apply.mjs --serial <ip>:5555 --tv-ip <ip>"
//   node tools/tv-apply.mjs --preflight                      laptop-only checks: adb, the APKs (hash + signer), the dream APK, the hub
//   $T --identify                                            read-only: model, SDK, ABI, Home; refuses a phone or a non-TV
//   $T --gates                                               read-only: can Claude and our dream APK install here? (exit 0; prints PASS/FAIL)
//   $T --backup                                              read-only: full state to devices/tv-backup-<date>/
//   $T                                                       dry run of the "safe" debloat tier (nothing changes)
//   $T --apply                                               disable the "safe" tier, logged before each change
//   $T --tier probably [--apply]                             safe + "probably safe"
//   $T --tier risky --only <pkg> [--apply]                   one risky package, by name
//   $T --settings [--apply]                                  the settings in tv-debloat.json (animation scales)
//   $T --set secure:screensaver_components=<pkg/.Cls> [--apply]
//   $T --install-claude [--apk-dir <dir>] [--apply]          Claude: signer + gates checked, then install-multiple
//   $T --install-dream [--apply]                             our screensaver / Claude-tile APK + its two grants
//   $T --density <dpi|reset> [--apply]                       `wm density`, the old value logged
//   $T --launch <pkg/.Activity>                              am start -n (no state change to undo)
//   $T --tile <dpi|restore>                                  open the Claude tile at that dpi (saved), or only put the density back
//   $T --dexopt                                              cmd package bg-dexopt-job (pre-compiles; nothing to undo)
//   $T --measure <label> [--gfx <pkg>]                       read-only: MemAvailable, process count, gfxinfo, screenshot
//   $T --screenshot devices/shots/x.png                      read-only
//   $T --undo devices/tv-undo-<date>.json [--last] [--apply] reverse a log (or only its last run)
//   node tools/tv-apply.mjs --selftest                       in-process fake TV, PASS/FAIL
//
// Rules it enforces (the owner's TV, the owner's phones on the same adb server):
//   - Dry run unless --apply. Only reversible actions: `pm disable-user --user 0` (undo `pm enable`), with --uninstall
//     `pm uninstall -k --user 0` (undo `cmd package install-existing`), `settings put` (undo: the old value, or delete),
//     `wm density` (undo: the old override, or reset), our own two apps installed (undo: uninstall, only if WE installed
//     them), `pm grant` (undo `pm revoke`), `appops set` (undo: the old mode). Never a full uninstall of anything else,
//     never root, never `pm clear` / `cmd package clear`, never a Play Store update uninstall, never a reboot, never
//     `adb kill-server` / connect / pair / tcpip.
//   - One explicit serial, which must be <--tv-ip>:<port>. The S24 (R5TEST00000, mDNS adb-tls names) and the POCO
//     (192.168.1.78, ZTTEST0000000000, model 2311DRK48G) are refused by name, address, serial number and model. The
//     device must say it is a TV (leanback feature or ro.build.characteristics "tv").
//   - Protected packages are refused whatever the data file says: a hard-coded core list (after CleanYourTV's
//     tools/disable.sh guards, MIT), the data file's `protected` and `keep` lists, every stock launcher until another
//     launcher is Home, and what the TV is using right now (Home, keyboards, WebView, screensaver, accessibility),
//     plus any package that serves a TV input. The adb wrapper checks the hard list again on every mutating command.
//   - Only packages listed in tools/tv-debloat.json and actually installed and enabled are touched. Installed packages
//     the list does not know are reported, never touched.
//   - Every change is written to devices/tv-undo-<date>.json BEFORE it is sent (status "pending"), then marked "done"
//     or "failed". --undo reverses every entry that is not "failed", newest first.
//   - Every child process runs with windowsHide: true.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { check as guardCheck, classifyShellLine } from "./tv-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, "..");
const DEFAULT_DATA = path.join(HERE, "tv-debloat.json");
const EXPECTED_FILE = path.join(HERE, "apk-expected.json");
const WINGET_ADB = path.join(os.homedir(), "AppData", "Local", "Microsoft", "WinGet", "Packages",
  "Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe", "scrcpy-win64-v4.1", "adb.exe");   // scrcpy from winget ships one
const DEFAULT_ADB = process.env.TV_ADB || (fs.existsSync(WINGET_ADB) ? WINGET_ADB : "adb");
const SDK_ROOT = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || path.join(os.homedir(), "AppData", "Local", "Android", "Sdk");

/* ---------------- hard safety lists (not editable through the data file) ---------------- */
const PKG_RE = /^[A-Za-z][\w]*(\.[\w]+)+$/;
const COMP_RE = /^[A-Za-z][\w]*(\.[\w]+)+\/[\w.$]+$/;
const FORBIDDEN_SERIALS = [/R5TEST00000/i, /ZTTEST0000000000/i, /_adb-tls-connect/i, /^adb-/i, /^emulator-/i];
const FORBIDDEN_IPS = ["192.168.1.78"];                                           // example: a phone on the LAN (edit for yours)
const FORBIDDEN_HW_SERIALS = ["R5TEST00000", "ZTTEST0000000000"];                 // example ro.serialno values of phones to refuse
const FORBIDDEN_MODELS = [/^SM-S928/i, /^2311DRK48/i, /duchamp/i];                 // the S24 Ultra, the POCO X6 Pro
const FORBIDDEN_ADB_ARGS = new Set(["kill-server", "start-server", "connect", "disconnect", "pair", "tcpip", "usb",
  "root", "unroot", "remount", "reboot", "sideload", "disable-verity", "enable-verity", "install", "install-multiple", "uninstall", "push", "pull"]);
const FORBIDDEN_SHELL = [
  /\bpm\s+clear\b/, /\bcmd\s+package\s+clear\b/,                                  // wipes data
  /\bpm\s+uninstall\b(?!\s+-k\s+--user\s+0\s)/, /\bcmd\s+package\s+uninstall\b/,  // only `pm uninstall -k --user 0 <pkg>` is reversible
  /uninstall-system-updates/, /\bpm\s+(hide|suspend|unsuspend|reset-permissions|set-installer|trim-caches)\b/,
  /\breboot\b/, /\bsu\b/, /\brm\s/, /\bsetprop\b/, /\bsvc\s/, /\bam\s+force-stop\b/, /\bmonkey\b/,
  /\bwm\s+(density|size)\s+\S/,                                                     // only through --density, which logs the old value
  /[;&|`$<>]/,
];
// Core Android and TV middleware: CleanYourTV's CORE_RE (tools/disable.sh, MIT) plus everything the owner's asks need:
// TV settings, live TV and inputs, Bluetooth, Cast, the phone remote and the remote's keys, Miracast, Play Store and
// Play services, keyboards, WebView.
const HARD_PROTECTED = [
  /^(android|android\.ext\.(services|shared))$/,
  /^com\.android\.(systemui|shell|phone|settings|tv\.settings|sdksandbox|location\.fused|providers\..*|permissioncontroller|packageinstaller|ext\.services|ext\.shared|modulemetadata|bluetooth|webview|inputdevices|networkstack.*|wifi.*|tv|vending|keychain|externalstorage|server\..*|media.*|inputmethod\..*|provision|managedprovisioning)$/,
  /^com\.google\.android\.(gms|gms\..*|gsf|permissioncontroller|packageinstaller|ext\.services|ext\.shared|modulemetadata|overlay\.modules.*|webview|trichromelibrary.*|inputmethod\..*|leanback\.ime|tv\.remote\.service|tv\.remotecontrol\..*|apps\.tv\.remotecontrol.*|apps\.mediashell|networkstack.*|tv\.axel|tv\.dfuservice|tv|tts|configupdater|tv\.frameworkpackagestubs|bluetooth|media.*|providers\..*)$/,
  /^com\.(mitv\.livetv.*|mediatek\.(tvinput|tis|tv\.service|tv\.agent|extservice|wwtv\.tvcenter|hotkey\.dispatcher|network|wwtv\.setupwizard|tvcenter.*)|droidlogic.*|cltv\.mal)$/,
  /^(mitv\.service|com\.mitv\.overseaservice|com\.mi\.bluetooth|com\.mitv\.setup|com\.xiaomi\.android\.tvsetup\.partnercustomizer|com\.xiaomi\.mitv\.(scenemode|settings|smartshare|res)|com\.xiaomi\.gtv\.settings|com\.xiaomi\.wfdsinkhelperservice|com\.mitv\.milinkservice|com\.xiaomi\.miplay|com\.duokan\.airkan\.tvbox)$/,
];
const STOCK_LAUNCHERS = ["com.mitv.tvhome.atv", "com.mitv.tvhome", "com.google.android.apps.tv.launcherx",
  "com.google.android.apps.tv.launcherx.overlay", "com.google.android.tvlauncher", "com.google.android.leanbacklauncher"];
const NOT_A_HOME = /^(com\.google\.android\.tungsten\.setupwraith|com\.android\.tv\.settings|com\.android\.settings|com\.android\.provision|android|com\.duokan\.factorytest)$|factory/i;
const SETUPWRAITH = "com.google.android.tungsten.setupwraith";
const LAUNCHERX = "com.google.android.apps.tv.launcherx";
const TIERS = { safe: ["safe"], probably: ["safe", "probably safe"], risky: ["safe", "probably safe", "risky"] };
const SAFE_VALUE = /^[\w.:\/,-]*$/;                       // a settings value we can pass to the shell AND put back exactly
const OUR_APPS = { "com.anthropic.claude": "claude", "dev.designyourtv": "dream" };
const TILE = "dev.designyourtv/.ClaudeTile";
const GRANTS = { "dev.designyourtv": ["android.permission.WRITE_SECURE_SETTINGS"] };
const APPOPS = { "dev.designyourtv": ["GET_USAGE_STATS"] };

export function isHardProtected(pkg) { return HARD_PROTECTED.some(re => re.test(pkg)); }

/* ---------------- args ---------------- */
function parseArgs(argv) {
  const o = { apply: false, tier: "safe", only: null, uninstall: false, settings: false, set: [], undo: null, last: false, identify: false,
    selftest: false, backup: false, screenshot: null, max: 25, data: DEFAULT_DATA, adb: DEFAULT_ADB, logDir: process.env.TV_LOG_DIR || path.join(PROJECT, "devices"),
    date: null, expectModel: null, preflight: false, gates: false, installClaude: false, apkDir: null, installDream: false,
    density: null, launch: null, dexopt: false, measure: null, gfx: null, expected: EXPECTED_FILE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${a} needs a value`); return x; };
    if (a === "--serial") o.serial = v();
    else if (a === "--tv-ip") o.tvIp = v();
    else if (a === "--apply") o.apply = true;
    else if (a === "--tier") o.tier = v();
    else if (a === "--only") o.only = v().split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--uninstall") o.uninstall = true;
    else if (a === "--settings") o.settings = true;
    else if (a === "--set") o.set.push(v());
    else if (a === "--undo") o.undo = v();
    else if (a === "--last") o.last = true;
    else if (a === "--identify") o.identify = true;
    else if (a === "--selftest") o.selftest = true;
    else if (a === "--backup") o.backup = true;
    else if (a === "--screenshot") o.screenshot = v();
    else if (a === "--max") o.max = Number(v());
    else if (a === "--data") o.data = v();
    else if (a === "--adb") o.adb = v();
    else if (a === "--log-dir") o.logDir = v();
    else if (a === "--date") o.date = v();
    else if (a === "--expect-model") o.expectModel = v();
    else if (a === "--preflight") o.preflight = true;
    else if (a === "--gates") o.gates = true;
    else if (a === "--install-claude") o.installClaude = true;
    else if (a === "--apk-dir") o.apkDir = v();
    else if (a === "--install-dream") o.installDream = true;
    else if (a === "--density") o.density = v();
    else if (a === "--launch") o.launch = v();
    else if (a === "--tile") o.tile = v();
    else if (a === "--dexopt") o.dexopt = true;
    else if (a === "--measure") o.measure = v();
    else if (a === "--gfx") o.gfx = v();
    else if (a === "--expected") o.expected = v();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!TIERS[o.tier]) throw new Error(`--tier must be safe, probably or risky`);
  if (o.density !== null && !/^(\d{2,3}|reset)$/.test(o.density)) throw new Error(`--density wants a dpi (e.g. 240) or reset`);
  if (o.measure !== null && !/^[\w.-]{1,40}$/.test(o.measure)) throw new Error(`--measure wants a short label (letters, digits, - . _)`);
  if (o.gfx && !PKG_RE.test(o.gfx)) throw new Error(`--gfx wants a package name`);
  if (o.launch && !COMP_RE.test(o.launch)) throw new Error(`--launch wants <pkg>/<.Activity>`);
  if (o.tile !== undefined && !/^(\d{3}|restore)$/.test(o.tile)) throw new Error(`--tile wants a dpi (120-640) or restore`);
  if (/^\d{3}$/.test(o.tile || "") && (Number(o.tile) < 120 || Number(o.tile) > 640)) throw new Error(`--tile dpi must be 120-640`);
  return o;
}

/* ---------------- the adb runner (real or injected) ---------------- */
// A path ending in .mjs/.js is a fake adb (tools/test/fake-adb.mjs) run by this same Node, never through a shell.
export function realAdb(adbPath) {
  const script = /\.(mjs|cjs|js)$/i.test(adbPath);
  return (args, o = {}) => new Promise(resolve => {
    const file = script ? process.execPath : adbPath;
    const argv = script ? [adbPath, ...args] : args;
    execFile(file, argv, { windowsHide: true, timeout: o.timeout || 120_000, maxBuffer: 64 * 1024 * 1024, encoding: o.binary ? "buffer" : "utf8" }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: o.binary ? stdout : String(stdout || ""), stderr: String(stderr || "") + (err && err.killed ? " (timed out)" : "") }));
  });
}
function runTool(file, args, timeout = 120_000) {
  return new Promise(resolve => {
    // .bat tools (apksigner) need cmd.exe; it is started hidden and given only fixed arguments plus our own file paths.
    const bat = /\.bat$/i.test(file);
    const exe = bat ? (process.env.ComSpec || "cmd.exe") : file;
    for (const a of args) if (/["%^&|<>]/.test(a)) return resolve({ code: 2, stdout: "", stderr: `refusing an argument with shell characters: ${a}` });
    const argv = bat ? ["/d", "/s", "/c", `""${file}" ${args.map(a => `"${a}"`).join(" ")}"`] : args;
    execFile(exe, argv, { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024, windowsVerbatimArguments: bat }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") }));
  });
}

class Refusal extends Error {}
class GateFailed extends Error {}

/** The verbs and packages a mutating shell command targets, for the wrapper's second check. */
function mutationTarget(cmd) {
  let m;
  if ((m = /^pm\s+(grant|revoke)\s+(?:--user\s+\d+\s+)?([A-Za-z][\w.]+)\s+\S+$/.exec(cmd))) return { verb: m[1], pkg: m[2] };
  if ((m = /^pm\s+(disable-user|disable|enable|uninstall|default-state)\b.*\s([A-Za-z][\w.]+)$/.exec(cmd))) return { verb: m[1], pkg: m[2] };
  if ((m = /^cmd\s+package\s+install-existing\b.*\s([A-Za-z][\w.]+)$/.exec(cmd))) return { verb: "install-existing", pkg: m[1] };
  if ((m = /^appops\s+set\s+([A-Za-z][\w.]+)\s/.exec(cmd))) return { verb: "appops", pkg: m[1] };
  return null;
}

/** Wraps the runner: every call but `devices -l` gets `-s <serial>`, and dangerous verbs never leave this file. */
function guardedAdb(run, serial, guard) {
  // tools/tv-guard.mjs: an install, launch, key, stop, display or unknown shell command only goes out while our app is in front
  // (and outside 18:00-01:00 SGT). Reads and plain settings are never gated. `guard` is injectable for tests.
  const guardIt = guard || (g => guardCheck({ ...g, serial, who: g.who || "tv-apply", run: async (exe, args) => { const r = await run(args); return { code: r.code, out: r.stdout, err: r.stderr }; } }));
  const gate = async (kind, pkg, what) => {
    const g = await guardIt({ kind, pkg, what });
    if (!g.ok) throw new Refusal(`⛔ TV GUARD refused ${kind}: ${g.reason}`);
  };
  const check = args => { for (const a of args) if (FORBIDDEN_ADB_ARGS.has(a)) throw new Refusal(`refusing to run adb ${a}`); };
  const sh = async (cmd, o = {}) => {
    for (const re of FORBIDDEN_SHELL) {
      if (o.density && re.source.startsWith("\\bwm")) continue;              // --density's own `wm density <n|reset>`
      if (re.test(cmd + " ")) throw new Refusal(`refusing shell command: ${cmd}`);
    }
    if (o.density && !/^wm density( \d{2,3}| reset)?$/.test(cmd)) throw new Refusal(`refusing shell command: ${cmd}`);
    const t = mutationTarget(cmd);
    if (t && (t.verb === "disable" || t.verb === "disable-user" || t.verb === "uninstall") && isHardProtected(t.pkg))
      throw new Refusal(`refusing ${t.verb} of ${t.pkg}: protected (hard-coded)`);
    if (t && (t.verb === "grant" || t.verb === "revoke" || t.verb === "appops") && !OUR_APPS[t.pkg])
      throw new Refusal(`refusing ${t.verb} on ${t.pkg}: only our own apps get grants`);
    const c = classifyShellLine(cmd);
    if (c.kind !== "read" && c.kind !== "setting") await gate(c.kind, c.pkg, cmd);
    const a = ["-s", serial, "shell", cmd]; check(a.slice(0, 3)); return run(a);
  };
  return {
    devices: async () => { const a = ["devices", "-l"]; check(a); return run(a); },
    sh,
    screencap: async () => run(["-s", serial, "exec-out", "screencap", "-p"], { binary: true }),
    /** install-multiple of APK files under apk/ (or a --apk-dir the owner chose), already verified by the caller. */
    installApks: async files => {
      for (const f of files) if (!/\.apk$/i.test(f) || !fs.existsSync(f)) throw new Refusal(`refusing to install ${f}`);
      await gate("install", null, `install-multiple ${files.length} file(s)`);
      return run(["-s", serial, "install-multiple", "-r", ...files], { timeout: 300_000 });
    },
    /** Full uninstall of one of OUR two apps only (never a system package). */
    uninstallOurs: async pkg => {
      if (!OUR_APPS[pkg]) throw new Refusal(`refusing to uninstall ${pkg}: only our own sideloaded apps`);
      await gate("install", null, `uninstall ${pkg}`);
      return run(["-s", serial, "uninstall", pkg]);
    },
  };
}

/* ---------------- serial and identity ---------------- */
export function checkSerial(serial, tvIp) {
  if (!serial) return "give the TV explicitly: --serial <tv-ip>:<port>";
  if (!tvIp) return "give the TV's address too: --tv-ip <ip> (Settings > Network on the TV)";
  for (const re of FORBIDDEN_SERIALS) if (re.test(serial)) return `refusing ${serial}: that is a phone or an emulator (the S24, the POCO or an mDNS adb name), never the TV`;
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})$/.exec(serial);
  if (!m) return `refusing ${serial}: the serial must be <ip>:<port>, e.g. ${tvIp}:5555`;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(tvIp)) return `--tv-ip ${tvIp} is not an IPv4 address`;
  if (m[1] !== tvIp) return `refusing ${serial}: it is not the TV's address ${tvIp}`;
  if (FORBIDDEN_IPS.includes(tvIp)) return `refusing ${tvIp}: that is the POCO X6, not the TV`;
  const [a, b] = tvIp.split(".").map(Number);
  if (!(a === 192 && b === 168) && a !== 10 && !(a === 172 && b >= 16 && b <= 31)) return `refusing ${tvIp}: not a home-network address`;
  return null;
}

const firstLine = r => (r.stdout || "").trim().split(/\r?\n/)[0]?.trim() || "";
async function identify(adb, serial) {
  const dev = await adb.devices();
  const line = (dev.stdout || "").split(/\r?\n/).find(l => l.split(/\s+/)[0] === serial);
  if (!line) throw new Refusal(`${serial} is not in \`adb devices\`. Run \`"$ADB" connect ${serial}\` and accept the prompt on the TV first.`);
  if (!/\sdevice(\s|$)/.test(line)) throw new Refusal(`${serial} is listed but not ready (${line.trim()}). Accept the "Allow debugging?" prompt on the TV.`);
  const props = {};
  for (const k of ["ro.product.manufacturer", "ro.product.brand", "ro.product.model", "ro.product.device", "ro.build.version.release",
    "ro.build.version.sdk", "ro.product.cpu.abilist", "ro.build.characteristics", "ro.build.fingerprint", "ro.adb.secure", "ro.serialno", "ro.config.low_ram"])
    props[k] = firstLine(await adb.sh(`getprop ${k}`));
  if (FORBIDDEN_HW_SERIALS.includes(props["ro.serialno"])) throw new Refusal(`${serial} is a phone (serial number ${props["ro.serialno"]}): never touched here. Nothing was changed.`);
  if (FORBIDDEN_MODELS.some(re => re.test(props["ro.product.model"]) || re.test(props["ro.product.device"]))) throw new Refusal(`${serial} is ${props["ro.product.model"]}, one of the owner's phones. Nothing was changed.`);
  const leanback = /true/.test(firstLine(await adb.sh("pm has-feature android.software.leanback")));
  const isTv = leanback || /\btv\b/.test(props["ro.build.characteristics"]);
  if (!isTv) throw new Refusal(`${serial} does not say it is a TV (no leanback feature, characteristics "${props["ro.build.characteristics"]}"). Nothing was changed.`);
  if (/samsung/i.test(props["ro.product.manufacturer"])) throw new Refusal(`${serial} is a Samsung device; the S24 is never touched.`);
  return { serial, model: props["ro.product.model"], manufacturer: props["ro.product.manufacturer"], brand: props["ro.product.brand"],
    device: props["ro.product.device"], android: props["ro.build.version.release"], sdk: Number(props["ro.build.version.sdk"]) || null,
    abilist: props["ro.product.cpu.abilist"], fingerprint: props["ro.build.fingerprint"], adbSecure: props["ro.adb.secure"],
    lowRam: props["ro.config.low_ram"] === "true", leanback };
}

/* ---------------- what the TV is using right now ---------------- */
const pkgsIn = text => [...new Set([...(text || "").matchAll(/([A-Za-z][\w]*(?:\.[\w]+)+)\/[\w.$]+/g)].map(m => m[1]))];
const parseList = text => new Set((text || "").split(/\r?\n/).map(l => l.trim().replace(/^package:/, "").split(/\s/)[0]).filter(p => PKG_RE.test(p)));
async function liveState(adb) {
  const installed = parseList((await adb.sh("pm list packages --user 0")).stdout);
  const disabled = parseList((await adb.sh("pm list packages -d --user 0")).stdout);
  const homeRes = await adb.sh("cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME");
  const homeLine = homeRes.code === 0 ? homeRes.stdout.trim().split(/\r?\n/).pop().trim() : "";
  const home = /\//.test(homeLine) ? homeLine.split("/")[0] : null;
  const claimsRes = await adb.sh("cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.HOME");
  const homeClaims = claimsRes.code === 0 ? pkgsIn(claimsRes.stdout) : null;
  const get = async (ns, key) => { const v = firstLine(await adb.sh(`settings get ${ns} ${key}`)); return v === "null" || v === "" ? null : v; };
  const ime = await get("secure", "default_input_method");
  const imes = await get("secure", "enabled_input_methods");
  const dream = await get("secure", "screensaver_components");
  const a11y = await get("secure", "enabled_accessibility_services");
  const wv = (await adb.sh("dumpsys webviewupdate")).stdout;
  const wvM = /Current WebView package \(name, version\): \(([\w.]+), ([\d.]+)/.exec(wv) || [];
  const inUse = new Map();
  if (home) inUse.set(home, "the current Home screen");
  for (const p of pkgsIn([ime, imes].filter(Boolean).join(":"))) inUse.set(p, "a keyboard in use");
  if (wvM[1]) inUse.set(wvM[1], "the WebView provider");
  for (const p of pkgsIn(dream || "")) inUse.set(p, "the current screensaver");
  for (const p of pkgsIn(a11y || "")) inUse.set(p, "an accessibility service in use");
  return { installed, disabled, home, homeClaims, dream, inUse, webview: wvM[1] || null, webviewVersion: wvM[2] || null };
}

/* ---------------- the data file ---------------- */
export function validateData(d) {
  const errs = [];
  if (!Array.isArray(d.packages)) return ["no packages[]"];
  const srcs = new Set(Object.keys(d.sources || {}));
  const seen = new Set();
  for (const e of d.packages) {
    const id = e && e.pkg;
    if (!id || !PKG_RE.test(id)) { errs.push(`bad package name ${JSON.stringify(id)}`); continue; }
    if (seen.has(id)) errs.push(`${id}: listed twice`); seen.add(id);
    if (!["safe", "probably safe", "risky"].includes(e.tier)) errs.push(`${id}: tier "${e.tier}"`);
    if (e.action !== "disable") errs.push(`${id}: action must be "disable" (reversible with pm enable)`);
    if (!e.reason) errs.push(`${id}: no reason`);
    if (!Array.isArray(e.sources) || !e.sources.length) errs.push(`${id}: no source`);
    else for (const s of e.sources) if (!srcs.has(s)) errs.push(`${id}: unknown source "${s}"`);
    if (isHardProtected(id)) errs.push(`${id}: hard-protected, must not be in the list`);
    if (STOCK_LAUNCHERS.includes(id) && e.requires !== "home-replaced") errs.push(`${id}: a launcher must say requires "home-replaced"`);
  }
  for (const k of d.keep || []) if (seen.has(k.pkg)) errs.push(`${k.pkg}: both kept and listed`);
  for (const s of d.settings || []) if (!/^(global|secure|system)$/.test(s.ns) || !SAFE_VALUE.test(String(s.value))) errs.push(`setting ${s.key}: bad ns or value`);
  return errs;
}
function loadData(file) {
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(d.packages)) throw new Error(`${file}: no packages[]`);
  return d;
}
function protectedReason(pkg, data) {
  if (isHardProtected(pkg)) return "core / never touch (hard-coded)";
  for (const p of data.protected || []) if (new RegExp(p.re).test(pkg)) return `protected: ${p.why}`;
  const k = (data.keep || []).find(k => k.pkg === pkg);
  if (k) return `kept: ${k.why}`;
  return null;
}

/* ---------------- planning ---------------- */
async function plan(adb, data, opt, ident, st) {
  const allowed = new Set(TIERS[opt.tier]);
  const out = [];
  const only = opt.only ? new Set(opt.only) : null;
  if (only) for (const p of only) if (!data.packages.some(x => x.pkg === p)) out.push({ pkg: p, verdict: "refused", why: "not in tools/tv-debloat.json (add it there with a reason and a source first)" });
  const selectedEarlier = new Set();
  // the setup wizard is decided before launcherx (see below)
  const ordered = [...data.packages].sort((a, b) => (a.pkg === LAUNCHERX) - (b.pkg === LAUNCHERX));
  for (const e of ordered) {
    const row = { pkg: e.pkg, name: e.name, tier: e.tier };
    if (!PKG_RE.test(e.pkg)) { out.push({ ...row, verdict: "refused", why: "not a package name" }); continue; }
    if (only && !only.has(e.pkg)) continue;
    if (!st.installed.has(e.pkg)) { out.push({ ...row, verdict: "absent", why: "not installed on this TV" }); continue; }
    if (st.disabled.has(e.pkg)) { out.push({ ...row, verdict: "already", why: "already disabled" }); continue; }
    const pr = protectedReason(e.pkg, data);
    if (pr) { out.push({ ...row, verdict: "refused", why: pr }); continue; }
    if (!allowed.has(e.tier)) { out.push({ ...row, verdict: "skipped", why: `tier "${e.tier}" needs --tier ${e.tier === "risky" ? "risky" : "probably"}` }); continue; }
    if (e.tier === "risky" && !(only && only.has(e.pkg))) { out.push({ ...row, verdict: "skipped", why: "risky: name it with --only" }); continue; }
    if (e.ask && !(only && only.has(e.pkg))) { out.push({ ...row, verdict: "skipped", why: `waits on the owner's answer (${e.ask}): name it with --only once the owner says yes` }); continue; }
    const use = st.inUse.get(e.pkg);
    const isHome = st.home === e.pkg;
    if (use && !(isHome && e.pkg === LAUNCHERX)) { out.push({ ...row, verdict: "refused", why: `in use right now: ${use}` }); continue; }
    // every stock launcher is gated, whatever the data file says
    if (e.requires === "home-replaced" || STOCK_LAUNCHERS.includes(e.pkg)) {
      const others = st.homeClaims && st.homeClaims.filter(p => !STOCK_LAUNCHERS.includes(p) && !NOT_A_HOME.test(p) && !st.disabled.has(p));
      if (!st.homeClaims || !st.home) { out.push({ ...row, verdict: "refused", why: "could not read which app owns Home, so every stock launcher is kept" }); continue; }
      if (!others.length) { out.push({ ...row, verdict: "refused", why: "no replacement launcher is installed: disabling it would leave a black screen" }); continue; }
      if (STOCK_LAUNCHERS.includes(st.home) && st.home !== e.pkg && st.home !== LAUNCHERX) { out.push({ ...row, verdict: "refused", why: `a stock launcher (${st.home}) is still Home: make the new launcher Home first` }); continue; }
      if (isHome) {
        // Google TV 14: Home goes by intent priority, so launcherx stays Home until it is disabled; the setup wizard
        // must already be off or Home falls to its RecoveryActivity and the TV soft-reboots every ~60 s (CleanYourTV).
        const wraithOff = !st.installed.has(SETUPWRAITH) || st.disabled.has(SETUPWRAITH) || selectedEarlier.has(SETUPWRAITH);
        if (!(e.pkg === LAUNCHERX && ident.sdk >= 34 && wraithOff)) {
          out.push({ ...row, verdict: "refused", why: e.pkg === LAUNCHERX ? "Google TV 14: disable the setup wizard (setupwraith) first, or Home crash-loops" : "it is Home right now: make the new launcher Home first (cmd package set-home-activity)" });
          continue;
        }
      }
    }
    if (e.requires === "screensaver-replaced") {
      const ours = pkgsIn(st.dream || "");
      const dreamPkgs = data.packages.filter(x => x.requires === "screensaver-replaced").map(x => x.pkg);
      if (!ours.length || ours.some(p => dreamPkgs.includes(p))) { out.push({ ...row, verdict: "refused", why: "set our screensaver first (secure screensaver_components still points at a stock one or is empty)" }); continue; }
    }
    if (e.requires === "wifi-not-owned") {
      const w = await adb.sh("dumpsys wifi");
      const owners = [...(w.stdout || "").matchAll(/cname=([^\s]+)/g)].map(m => m[1]);
      if (!owners.length) { out.push({ ...row, verdict: "refused", why: "could not read which app owns the saved Wi-Fi networks, so the setup wizard is kept (it could take the TV off Wi-Fi)" }); continue; }
      if (owners.some(o => o.includes("setupwraith"))) { out.push({ ...row, verdict: "refused", why: "the saved Wi-Fi network belongs to the setup wizard: forget and re-join it in Settings > Network first" }); continue; }
    }
    // CleanYourTV's input guard: anything that serves a TV input (HDMI, tuner) stays on, and so does anything unreadable.
    const dp = await adb.sh(`dumpsys package ${e.pkg}`);
    const txt = dp.stdout || "";
    if (!txt.includes(`Package [${e.pkg}]`)) { out.push({ ...row, verdict: "refused", why: "could not read its dumpsys entry, so it is kept" }); continue; }
    if (/TV_INPUT_HARDWARE|android\.media\.tv\.TvInputService/.test(txt)) { out.push({ ...row, verdict: "refused", why: "it serves a TV input (HDMI / tuner)" }); continue; }
    const mode = opt.uninstall && !e.disableOnly && e.tier === "safe" ? "uninstall-user" : "disable-user";
    out.push({ ...row, verdict: "change", mode, why: e.reason });
    selectedEarlier.add(e.pkg);
  }
  return out;
}
function unknownPackages(data, st) {
  const listed = new Set(data.packages.map(p => p.pkg));
  return [...st.installed].filter(p => !listed.has(p) && !protectedReason(p, data) && !OUR_APPS[p]).sort();
}

/* ---------------- the undo log (write-ahead) ---------------- */
function sgtDate(opt) { return opt.date || new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); }
function logPathFor(opt) { return path.join(opt.logDir, `tv-undo-${sgtDate(opt)}.json`); }
function readLog(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function writeLog(file, log) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(log, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
function openLog(file, ident) {
  const log = readLog(file) || { $comment: "Undo log for tools/tv-apply.mjs. Each entry is written BEFORE its change is sent (status pending), then marked done or failed. Undo with: node tools/tv-apply.mjs --serial <ip:port> --tv-ip <ip> --undo <this file> --apply", device: null, runs: [], entries: [] };
  if (log.device && log.device.model !== ident.model) throw new Refusal(`${file} belongs to ${log.device.model}, not ${ident.model}`);
  log.device = log.device || { model: ident.model, manufacturer: ident.manufacturer, device: ident.device, fingerprint: ident.fingerprint, sdk: ident.sdk };
  return log;
}
/** One log per run: intend() writes the entry to disk before the change; settle() marks it. */
function journal(opt, ident) {
  const file = logPathFor(opt);
  const runId = new Date().toISOString() + "#" + crypto.randomBytes(3).toString("hex");
  let log = null, changes = 0;
  return {
    file, runId,
    get used() { return !!log; },
    get changes() { return changes; },
    intend(entry) {
      log = log || openLog(file, ident);
      log.entries.push({ ...entry, run: runId, status: "pending", at: new Date().toISOString() });
      writeLog(file, log);
      return log.entries.length - 1;
    },
    settle(i, ok, detail) {
      log.entries[i].status = ok ? "done" : "failed";
      if (detail) log.entries[i].detail = String(detail).slice(0, 300);
      writeLog(file, log);
      if (ok) changes++;
    },
    close(extra) {
      if (!log) return;
      log.runs.push({ run: runId, tier: opt.tier, only: opt.only, changes, ...extra });
      writeLog(file, log);
    },
  };
}

/* ---------------- APK checks (laptop side) ---------------- */
function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function buildTool(name) {
  const bt = path.join(SDK_ROOT, "build-tools");
  if (!fs.existsSync(bt)) return null;
  for (const v of fs.readdirSync(bt).sort().reverse()) for (const n of [name, name + ".exe", name + ".bat"]) {
    const p = path.join(bt, v, n); if (fs.existsSync(p)) return p;
  }
  return null;
}
/** Signer SHA-256 of an APK, from apksigner (null when it can't be read). */
async function signerDigest(apk) {
  const tool = buildTool("apksigner");
  if (!tool) return { ok: false, why: "apksigner not found in the Android SDK build-tools" };
  const r = await runTool(tool, ["verify", "--print-certs", apk], 180_000);
  const m = /Signer #1 certificate SHA-256 digest: ([0-9a-f]{64})/.exec(r.stdout);
  const signers = Number((/Number of signers: (\d+)/.exec(r.stdout) || [])[1] || (m ? 1 : 0));
  return { ok: r.code === 0 && !!m, digest: m ? m[1] : null, signers, why: r.code ? (r.stderr || r.stdout).trim().slice(0, 300) : null };
}
async function badging(apk) {
  const tool = buildTool("aapt2");
  if (!tool) return null;
  const r = await runTool(tool, ["dump", "badging", apk], 60_000);
  if (r.code) return null;
  const t = r.stdout;
  return {
    pkg: (/package: name='([^']+)'/.exec(t) || [])[1] || null,
    versionName: (/versionName='([^']*)'/.exec(t) || [])[1] || null,
    split: (/ split='([^']+)'/.exec(t) || [])[1] || null,
    minSdk: Number((/minSdkVersion:'(\d+)'/.exec(t) || /sdkVersion:'(\d+)'/.exec(t) || [])[1] || 0) || null,
    nativeCode: ((/native-code: (.*)/.exec(t) || [])[1] || "").match(/'([^']+)'/g)?.map(s => s.replace(/'/g, "")) || [],
    leanback: /leanback-launchable-activity/.test(t),
  };
}
function loadExpected(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

/** Everything about a Claude APK set that can be checked on the laptop: files, signer, minSdk, ABIs. */
async function checkClaudeSet(dir, exp, { strictHashes }) {
  const c = exp.claude;
  const res = { ok: true, lines: [], files: [], minSdk: null, abis: [] };
  const bad = s => { res.ok = false; res.lines.push(`FAIL  ${s}`); };
  const good = s => res.lines.push(`PASS  ${s}`);
  if (!fs.existsSync(dir)) { bad(`${dir} does not exist`); return res; }
  const apks = fs.readdirSync(dir).filter(f => /\.apk$/i.test(f)).sort();
  if (!apks.includes("base.apk")) { bad(`${dir} has no base.apk`); return res; }
  for (const f of apks) res.files.push(path.join(dir, f));
  if (strictHashes) {
    for (const [name, want] of Object.entries(c.files)) {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) { bad(`${name} missing`); continue; }
      const got = sha256(p);
      if (got !== want) bad(`${name} sha256 ${got.slice(0, 12)}… is not the proven ${want.slice(0, 12)}…`); else good(`${name} sha256 matches the POCO's Play Store copy`);
    }
  }
  for (const p of res.files) {
    const s = await signerDigest(p);
    if (!s.ok) { bad(`${path.basename(p)}: signature does not verify (${s.why})`); continue; }
    if (s.signers !== 1 || s.digest !== c.signerSha256) bad(`${path.basename(p)}: signer ${s.digest} is not Anthropic's Play signer ${c.signerSha256}`);
    else good(`${path.basename(p)}: signed by ${c.signerSha256.slice(0, 16)}… (Anthropic's Play signer)`);
  }
  const b = await badging(path.join(dir, "base.apk"));
  if (!b) bad("aapt2 could not read base.apk");
  else {
    if (b.pkg !== c.pkg) bad(`base.apk is ${b.pkg}, not ${c.pkg}`);
    res.minSdk = b.minSdk; res.versionName = b.versionName;
    good(`base.apk: ${b.pkg} ${b.versionName}, minSdk ${b.minSdk}`);
  }
  for (const p of res.files) {
    const bb = await badging(p);
    if (bb && bb.nativeCode.length) res.abis.push(...bb.nativeCode);
  }
  res.abis = [...new Set(res.abis)];
  return res;
}

/* ---------------- preflight (laptop only, no TV) ---------------- */
async function preflight(opt, run, print) {
  const exp = loadExpected(opt.expected);
  let fails = 0;
  const pass = s => print(`PASS  ${s}`), fail = s => { fails++; print(`FAIL  ${s}`); }, warn = s => print(`WARN  ${s}`);
  // 1. adb
  const v = await run(["version"]);
  const ver = (/Android Debug Bridge version ([\d.]+)/.exec(v.stdout) || [])[1];
  if (v.code === 0 && ver) pass(`adb ${ver} at ${opt.adb}`); else fail(`adb did not answer at ${opt.adb}`);
  // 2. the debloat data
  const errs = validateData(loadData(opt.data));
  if (errs.length) fail(`tv-debloat.json: ${errs.slice(0, 5).join("; ")}`); else pass(`tv-debloat.json: every package has a tier, a reason, a known source and a reversible action`);
  // 3. Claude APKs
  const c = await checkClaudeSet(path.join(PROJECT, exp.claude.dir), exp, { strictHashes: true });
  for (const l of c.lines) l.startsWith("PASS") ? print(l) : (fails++, print(l));
  // 4. our dream APK
  const dreamApk = path.join(PROJECT, exp.dream.file);
  if (!fs.existsSync(dreamApk)) fail(`${exp.dream.file} is not built: node tools/build-tv-apk.mjs`);
  else {
    const s = await signerDigest(dreamApk);
    const b = await badging(dreamApk);
    if (!s.ok) fail(`${exp.dream.file}: signature does not verify`);
    else if (!b || b.pkg !== exp.dream.pkg) fail(`${exp.dream.file}: package ${b && b.pkg}`);
    else pass(`${exp.dream.file}: ${b.pkg} ${b.versionName}, minSdk ${b.minSdk}, signed (debug key ${s.digest.slice(0, 12)}…)${b.leanback ? ", has a TV launcher tile" : ""}`);
  }
  // 5. the hub (the screensaver's page) and its deny list
  try {
    const h = await fetch("http://127.0.0.1:8790/api/health", { signal: AbortSignal.timeout(4000) }).then(r => r.json());
    if (h.ok) pass(`hub answers on :8790 (${(h.lan_ips || []).includes("192.168.1.10") ? "192.168.1.10 is one of its addresses" : "WARNING: 192.168.1.10 is not among " + (h.lan_ips || []).join(", ")})`);
    else fail("hub /api/health did not say ok");
    const deny = await fetch("http://127.0.0.1:8790/apk/claude/split_config.xxhdpi.apk", { signal: AbortSignal.timeout(4000) });
    if (deny.status === 200) fail("hub serves apk/ to the network: add apk and devices to DENY in hub/server.mjs"); else pass(`hub refuses /apk/ and /devices/ (HTTP ${deny.status})`);
    const page = await fetch("http://127.0.0.1:8790/tv-setup.html?kiosk=tv", { signal: AbortSignal.timeout(4000) });
    if (page.status === 200) pass("hub serves tv-setup.html (the screensaver's page)"); else fail(`tv-setup.html: HTTP ${page.status}`);
  } catch (e) { warn(`hub not reachable on :8790 (${e.message}); the screensaver falls back to its built-in clock until it is: start it with node hub/server.mjs`); }
  print(fails ? `${fails} check(s) failed` : "preflight: all checks passed");
  return { changes: 0, fails };
}

/* ---------------- gates (TV, read-only) ---------------- */
async function gates(adb, ident, opt, print) {
  const exp = loadExpected(opt.expected);
  const abis = (ident.abilist || "").split(",").filter(Boolean);
  const df = (await adb.sh("df -k /data")).stdout;
  const free = (() => { const l = df.trim().split(/\r?\n/).pop().split(/\s+/); const n = Number(l[3]); return Number.isFinite(n) ? Math.round(n / 1024) : null; })();
  const st = await liveState(adb);
  const claudeMin = exp.claude.minSdk, claudeAbis = exp.claude.nativeCode;
  const g = {
    claude: {
      sdk: ident.sdk >= claudeMin, abi: claudeAbis.some(a => abis.includes(a)), storage: free === null ? null : free >= 500,
      installed: st.installed.has(exp.claude.pkg),
    },
    dream: { sdk: ident.sdk >= exp.dream.minSdk, webview: st.webviewVersion ? Number(st.webviewVersion.split(".")[0]) : null },
    freeMB: free, abis, sdk: ident.sdk, lowRam: ident.lowRam,
  };
  print(`Claude ${exp.claude.versionName}: SDK ${ident.sdk} ${g.claude.sdk ? "PASS" : `FAIL (needs ${claudeMin}: go to step 9-ALT)`}; ABI ${abis.join(",") || "?"} ${g.claude.abi ? "PASS" : `FAIL (the proven build has only ${claudeAbis.join(",")}: go to step 9-ALT)`}; free ${free ?? "?"} MB ${g.claude.storage === false ? "FAIL (needs 500 MB)" : "PASS"}${g.claude.installed ? "; already installed" : ""}`);
  print(`Dream APK: SDK ${ident.sdk} ${g.dream.sdk ? "PASS" : "FAIL"}; WebView ${st.webview || "?"} ${st.webviewVersion || "?"} ${g.dream.webview === null ? "UNKNOWN" : g.dream.webview >= 105 ? "PASS" : "FAIL (page needs Chromium 105+: update Android System WebView from the Play Store)"}`);
  if (ident.lowRam) print("note: ro.config.low_ram is true, so multi-window/freeform is off on this TV (route B in 8b is not available)");
  print(JSON.stringify(g));
  return { ident, changes: 0, gates: g };
}

/* ---------------- installs, grants, density ---------------- */
async function installClaude(adb, ident, opt, print, j) {
  const exp = loadExpected(opt.expected);
  const dir = path.resolve(opt.apkDir || path.join(PROJECT, exp.claude.dir));
  const strict = !opt.apkDir;
  const c = await checkClaudeSet(dir, exp, { strictHashes: strict });
  for (const l of c.lines) print(`  ${l}`);
  if (!c.ok) throw new Refusal(`the Claude APKs in ${dir} are not proven to be Anthropic's: nothing installed`);
  const abis = (ident.abilist || "").split(",").filter(Boolean);
  if (c.minSdk && ident.sdk < c.minSdk) throw new GateFailed(`GATE FAILED: this build needs SDK ${c.minSdk}, the TV has ${ident.sdk}. Go to step 9-ALT.`);
  const abiSplits = c.files.filter(f => /split_config\.(arm64_v8a|armeabi_v7a|x86_64|x86)\.apk$/i.test(f));
  let files = c.files;
  if (abiSplits.length) {
    const want = abis.map(a => a.replace(/-/g, "_"));
    const pick = want.map(a => abiSplits.find(f => f.toLowerCase().includes(`split_config.${a}.apk`))).find(Boolean);
    if (!pick) throw new GateFailed(`GATE FAILED: no native-code split for this TV's ABIs (${abis.join(",")}); the set has ${c.abis.join(",")}. Go to step 9-ALT.`);
    files = c.files.filter(f => !abiSplits.includes(f) || f === pick);
  } else if (c.abis.length && !c.abis.some(a => abis.includes(a))) {
    throw new GateFailed(`GATE FAILED: base.apk carries ${c.abis.join(",")}, the TV runs ${abis.join(",")}. Go to step 9-ALT.`);
  }
  const st = await liveState(adb);
  if (st.installed.has(exp.claude.pkg)) {
    const v = /versionName=(\S+)/.exec((await adb.sh(`dumpsys package ${exp.claude.pkg}`)).stdout);
    print(`  = ${exp.claude.pkg} is already installed (${v ? v[1] : "?"}); left as it is`);
    return;
  }
  print(`  ${opt.apply ? "INSTALL" : "would install"} ${files.map(f => path.basename(f)).join(" + ")}`);
  if (!opt.apply) return;
  const i = j.intend({ action: "install", pkg: exp.claude.pkg, wasInstalled: false, files: files.map(f => path.basename(f)) });
  const r = await adb.installApks(files);
  const ok = r.code === 0 && /Success/.test(r.stdout + r.stderr);
  j.settle(i, ok, (r.stdout + r.stderr).trim());
  if (!ok) throw new Refusal(`install failed: ${(r.stdout + r.stderr).trim().slice(0, 300)}`);
  print(`    Success`);
}

async function installDream(adb, ident, opt, print, j) {
  const exp = loadExpected(opt.expected);
  const apk = path.join(PROJECT, exp.dream.file);
  if (!fs.existsSync(apk)) throw new Refusal(`${exp.dream.file} is not built (node tools/build-tv-apk.mjs)`);
  const s = await signerDigest(apk);
  const b = await badging(apk);
  if (!s.ok || !b || b.pkg !== exp.dream.pkg) throw new Refusal(`${exp.dream.file} does not verify as ${exp.dream.pkg}`);
  if (ident.sdk < b.minSdk) throw new GateFailed(`GATE FAILED: our APK needs SDK ${b.minSdk}, the TV has ${ident.sdk}`);
  const pkg = exp.dream.pkg;
  const st = await liveState(adb);
  if (st.installed.has(pkg)) print(`  = ${pkg} already installed; reinstalling the current build over it keeps its data (not logged: undo leaves it)`);
  print(`  ${opt.apply ? "INSTALL" : "would install"} ${exp.dream.file} (${b.versionName})`);
  if (opt.apply) {
    const i = st.installed.has(pkg) ? null : j.intend({ action: "install", pkg, wasInstalled: false, files: [path.basename(apk)] });
    const r = await adb.installApks([apk]);
    const ok = r.code === 0 && /Success/.test(r.stdout + r.stderr);
    if (i !== null) j.settle(i, ok, (r.stdout + r.stderr).trim());
    if (!ok) throw new Refusal(`install failed: ${(r.stdout + r.stderr).trim().slice(0, 300)}`);
    print("    Success");
  }
  for (const perm of GRANTS[pkg] || []) {
    const has = /granted=true/.test((await adb.sh(`dumpsys package ${pkg}`)).stdout.split(perm)[1]?.slice(0, 40) || "");
    if (has) { print(`  = ${perm} already granted`); continue; }
    print(`  ${opt.apply ? "GRANT" : "would grant"} ${perm}`);
    if (!opt.apply) continue;
    const i = j.intend({ action: "grant", pkg, perm });
    const r = await adb.sh(`pm grant ${pkg} ${perm}`);
    j.settle(i, r.code === 0, r.stderr || r.stdout);
    if (r.code) print(`    failed: ${(r.stderr || r.stdout).trim()}`);
  }
  for (const op of APPOPS[pkg] || []) {
    const cur = (new RegExp(`${op}: (\\w+)`).exec((await adb.sh(`appops get ${pkg} ${op}`)).stdout) || [])[1] || "default";
    if (cur === "allow") { print(`  = appop ${op} already allow`); continue; }
    print(`  ${opt.apply ? "APPOP" : "would set appop"} ${op}: ${cur} -> allow`);
    if (!opt.apply) continue;
    const i = j.intend({ action: "appops", pkg, op, old: cur, value: "allow" });
    const r = await adb.sh(`appops set ${pkg} ${op} allow`);
    j.settle(i, r.code === 0, r.stderr || r.stdout);
  }
}

function parseDensity(text) {
  const phys = Number((/Physical density: (\d+)/.exec(text) || [])[1]) || null;
  const over = Number((/Override density: (\d+)/.exec(text) || [])[1]) || null;
  return { physical: phys, override: over };
}
async function density(adb, opt, print, j) {
  const cur = parseDensity((await adb.sh("wm density", { density: true })).stdout);
  if (!cur.physical) throw new Refusal("could not read `wm density`");
  const target = opt.density === "reset" ? null : Number(opt.density);
  if (target !== null && (target < 120 || target > 640)) throw new Refusal(`density ${target} is out of range (120-640)`);
  if ((cur.override || null) === target) { print(`  = density is already ${target ?? "reset (" + cur.physical + ")"}`); return; }
  print(`  ${opt.apply ? "DENSITY" : "would set density"}: ${cur.override ?? `${cur.physical} (physical)`} -> ${target ?? `reset (${cur.physical})`}`);
  if (!opt.apply) return;
  const i = j.intend({ action: "density", old: cur.override, physical: cur.physical, value: target });
  const r = await adb.sh(target === null ? "wm density reset" : `wm density ${target}`, { density: true });
  j.settle(i, r.code === 0, r.stderr || r.stdout);
  print("    undo: --undo this log, or by hand `wm density reset`");
}

/* ---------------- read-only measurements ---------------- */
async function measure(adb, opt, ident, print) {
  const mem = (await adb.sh("cat /proc/meminfo")).stdout;
  const kb = k => Number((new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(mem) || [])[1]) || null;
  const ps = (await adb.sh("ps -A")).stdout.trim().split(/\r?\n/).length - 1;
  const out = { label: opt.measure, at: new Date().toISOString(), memTotalMB: Math.round(kb("MemTotal") / 1024), memAvailableMB: Math.round(kb("MemAvailable") / 1024), processes: ps };
  if (opt.gfx) {
    const g = (await adb.sh(`dumpsys gfxinfo ${opt.gfx}`)).stdout;
    out.gfx = { pkg: opt.gfx, frames: Number((/Total frames rendered: (\d+)/.exec(g) || [])[1]) || 0, janky: Number((/Janky frames: (\d+)/.exec(g) || [])[1]) || 0,
      jankyPct: Number((/Janky frames: \d+ \(([\d.]+)%\)/.exec(g) || [])[1]) || 0 };
  }
  const shot = await adb.screencap();
  const dir = path.join(opt.logDir, "shots");
  if (shot.code === 0 && Buffer.isBuffer(shot.stdout) && shot.stdout.length > 8 && shot.stdout.readUInt32BE(0) === 0x89504e47) {
    fs.mkdirSync(dir, { recursive: true });
    out.screenshot = path.join(dir, `${opt.measure}.png`);
    fs.writeFileSync(out.screenshot, shot.stdout);
  }
  const file = path.join(opt.logDir, `tv-measure-${opt.measure}.json`);
  fs.mkdirSync(opt.logDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ device: ident.model, ...out }, null, 2) + "\n");
  print(`Measure ${opt.measure}: MemAvailable ${out.memAvailableMB} of ${out.memTotalMB} MB, ${ps} processes${out.gfx ? `, ${out.gfx.pkg}: ${out.gfx.janky} janky of ${out.gfx.frames} frames (${out.gfx.jankyPct}%)` : ""}${out.screenshot ? `, screenshot ${path.relative(PROJECT, out.screenshot)}` : ""} -> ${path.relative(PROJECT, file)}`);
  return { ident, changes: 0, measure: out };
}

/* ---------------- main flows ---------------- */
async function main(opt, run, print = console.log, guard = undefined) {
  if (opt.preflight) return preflight(opt, run, print);
  const bad = checkSerial(opt.serial, opt.tvIp);
  if (bad) throw new Refusal(bad);
  const adb = guardedAdb(run, opt.serial, guard);
  const ident = await identify(adb, opt.serial);
  if (opt.expectModel && ident.model !== opt.expectModel) throw new Refusal(`expected model ${opt.expectModel}, the TV says ${ident.model}`);
  print(`TV: ${ident.manufacturer} ${ident.model} (${ident.device}), Android ${ident.android}, SDK ${ident.sdk}, ABI ${ident.abilist}`);
  if (ident.adbSecure === "0" || ident.adbSecure === "") print("  note: ro.adb.secure is not 1, so port 5555 may give any device on the network a shell. Switch network debugging off when done.");
  if (opt.identify) { print(JSON.stringify(ident, null, 2)); return { ident, changes: 0 }; }
  if (opt.backup) return backup(adb, opt, ident, print);
  if (opt.gates) return gates(adb, ident, opt, print);
  if (opt.measure) return measure(adb, opt, ident, print);
  if (opt.screenshot) {
    const r = await adb.screencap();
    const buf = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout || "");
    if (r.code !== 0 || buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Refusal(`screencap failed: ${String(r.stderr).slice(0, 200)}`);
    fs.mkdirSync(path.dirname(path.resolve(opt.screenshot)), { recursive: true });
    fs.writeFileSync(opt.screenshot, buf);
    print(`Saved ${opt.screenshot} (${buf.length} bytes)`);
    return { ident, changes: 0 };
  }
  if (opt.launch) {
    const r = await adb.sh(`am start -n ${opt.launch}`);
    print((r.stdout + r.stderr).trim());
    if (r.code || /Error/.test(r.stdout + r.stderr)) throw new Refusal(`could not start ${opt.launch}`);
    return { ident, changes: 0 };
  }
  if (opt.tile) {
    // our own tile: it saves the dpi, switches, opens Claude, and its guard puts the density back when Claude leaves.
    // Nothing to log: the tile's own restore (Home, its next open, boot, --tile restore) and --density reset undo it.
    const extra = opt.tile === "restore" ? "--ez restore true" : `--ei dpi ${Number(opt.tile)}`;
    // --activity-clear-task: always a fresh tile (onCreate), never an intent handed to one that is still closing
    // (measured on the API 33 emulator, 3 Nov: a restore sent ~2 s after an open was dropped that way).
    const r = await adb.sh(`am start -W --activity-clear-task -n ${TILE} ${extra}`);
    print((r.stdout + r.stderr).trim());
    if (r.code || /Error/.test(r.stdout + r.stderr)) throw new Refusal(`could not start the Claude tile (is the dream APK installed? --install-dream)`);
    const d = parseDensity((await adb.sh("wm density", { density: true })).stdout);
    print(`  density now: ${d.override ? `${d.override} (override; physical ${d.physical})` : `${d.physical} (physical, no override)`}`);
    return { ident, changes: 0, density: d };
  }
  if (opt.dexopt) {
    const r = await adb.sh("cmd package bg-dexopt-job");
    print((r.stdout + r.stderr).trim() || "bg-dexopt-job finished");
    return { ident, changes: 0 };
  }
  if (opt.undo) return undo(adb, opt, ident, print);

  const j = journal(opt, ident);
  const finish = () => {
    j.close();
    if (j.used) print(`Undo log: ${path.relative(PROJECT, j.file) || j.file}`);
    return { ident, changes: j.changes, logFile: j.used ? j.file : null };
  };
  if (opt.installClaude) { await installClaude(adb, ident, opt, print, j); if (!opt.apply) print("Dry run: nothing was changed. Add --apply."); return finish(); }
  if (opt.installDream) { await installDream(adb, ident, opt, print, j); if (!opt.apply) print("Dry run: nothing was changed. Add --apply."); return finish(); }
  if (opt.density !== null) { await density(adb, opt, print, j); if (!opt.apply) print("Dry run: nothing was changed. Add --apply."); return finish(); }

  const data = loadData(opt.data);
  const derr = validateData(data);
  if (derr.length) throw new Refusal(`tv-debloat.json is not valid: ${derr.slice(0, 5).join("; ")}`);
  const st = await liveState(adb);
  print(`Home: ${st.home || "unknown"} | screensaver: ${st.dream || "default"} | WebView: ${st.webview || "unknown"} ${st.webviewVersion || ""}`);

  // settings
  const sets = [];
  if (opt.settings) for (const s of data.settings || []) if (TIERS[opt.tier].includes(s.tier)) sets.push(s);
  for (const kv of opt.set) {
    const m = /^(global|secure|system):([A-Za-z0-9_.]+)=(.*)$/.exec(kv);
    if (!m) throw new Refusal(`--set wants ns:key=value, got ${kv}`);
    sets.push({ ns: m[1], key: m[2], value: m[3], reason: "--set" });
  }
  for (const s of sets) {
    if (!SAFE_VALUE.test(s.value)) throw new Refusal(`refusing the value for ${s.key}: only letters, digits and . : / , - _`);
    const old = firstLine(await adb.sh(`settings get ${s.ns} ${s.key}`));
    const oldV = old === "null" || old === "" ? null : old;
    if (oldV === s.value) { print(`  = ${s.ns} ${s.key} is already ${s.value}`); continue; }
    if (oldV !== null && !SAFE_VALUE.test(oldV)) { print(`  REFUSED ${s.ns} ${s.key}: its current value "${oldV}" could not be put back exactly, so it is left alone`); continue; }
    print(`  ${opt.apply ? "SET" : "would set"} ${s.ns} ${s.key}: ${oldV ?? "(unset)"} -> ${s.value}`);
    if (opt.apply) {
      const i = j.intend({ action: "setting", ns: s.ns, key: s.key, old: oldV, value: s.value });
      const r = await adb.sh(`settings put ${s.ns} ${s.key} ${s.value}`);
      j.settle(i, r.code === 0, r.stderr || r.stdout);
      if (r.code !== 0) print(`    failed: ${(r.stderr || r.stdout).trim()}`);
    }
  }
  // debloat (skipped when the run is only about settings, unless --only names packages too)
  if (!(opt.settings || opt.set.length) || opt.only) {
    const rows = await plan(adb, data, opt, ident, st);
    const groups = v => rows.filter(r => r.verdict === v);
    for (const r of groups("refused")) print(`  REFUSED ${r.pkg}: ${r.why}`);
    for (const r of groups("skipped")) print(`  skip    ${r.pkg} (${r.tier}): ${r.why}`);
    print(`  ${groups("absent").length} listed packages are not on this TV; ${groups("already").length} are already disabled.`);
    const unk = unknownPackages(data, st);
    if (unk.length) print(`  UNKNOWN (reported, never touched): ${unk.length} installed packages the list does not know: ${unk.join(" ")}`);
    const todo = groups("change").slice(0, opt.max);
    if (groups("change").length > todo.length) print(`  (batch limit ${opt.max}: ${groups("change").length - todo.length} more next run)`);
    for (const r of todo) {
      print(`  ${opt.apply ? "DO" : "would"} ${r.mode} ${r.pkg} [${r.tier}] ${r.name}: ${r.why}`);
      if (!opt.apply) continue;
      const cmd = r.mode === "uninstall-user" ? `pm uninstall -k --user 0 ${r.pkg}` : `pm disable-user --user 0 ${r.pkg}`;
      const i = j.intend({ action: r.mode, pkg: r.pkg, tier: r.tier });
      const res = await adb.sh(cmd);
      const okText = r.mode === "uninstall-user" ? /Success/i : /disabled-user|new state: disabled/i;
      const ok = res.code === 0 && okText.test(res.stdout + res.stderr);
      j.settle(i, ok, (res.stdout + res.stderr).trim());
      if (!ok) { print(`    the TV refused: ${(res.stdout + res.stderr).trim().slice(0, 200)}`); continue; }
      if (STOCK_LAUNCHERS.includes(r.pkg) || r.pkg === SETUPWRAITH) {
        // Home must still land on a real launcher; if it doesn't, put this one back at once (CleanYourTV's rollback idea).
        const h = await adb.sh("cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME");
        const owner = (h.stdout.trim().split(/\r?\n/).pop() || "").split("/")[0];
        if (!owner || !/\//.test(h.stdout) || NOT_A_HOME.test(owner)) {
          print(`    Home now resolves to "${owner || "nothing"}": re-enabling ${r.pkg} and stopping.`);
          const k = j.intend({ action: "rollback-enable", pkg: r.pkg });
          const rr = await adb.sh(`pm enable --user 0 ${r.pkg}`);
          j.settle(k, rr.code === 0, rr.stdout);
          break;
        }
        print(`    Home is now ${owner}.`);
      }
    }
    if (!opt.apply) print(`Dry run: nothing was changed. Add --apply to do the ${todo.length} change(s) above.`);
  } else if (!opt.apply) print("Dry run: nothing was changed. Add --apply to change the settings above.");
  const res = finish();
  if (opt.apply && res.changes) print("Now: the checks in step 5 (Home, Wi-Fi, remote, HDMI, picture, a cast from the phone, Miracast), then reboot once and check again.");
  return res;
}

/** Read-only: everything needed to put the TV back, saved under devices/tv-backup-<date>/ (git-ignored). */
async function backup(adb, opt, ident, print) {
  const d = sgtDate(opt);
  let dir = path.join(opt.logDir, `tv-backup-${d}`);
  for (let n = 2; fs.existsSync(dir) && fs.readdirSync(dir).length; n++) dir = path.join(opt.logDir, `tv-backup-${d}-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  const st = await liveState(adb);
  const extra = [...new Set([st.home, ...pkgsIn(st.dream || ""), ...STOCK_LAUNCHERS, "com.google.android.backdrop", "com.google.android.apps.tv.dreamx",
    "com.mitv.dream", "com.mitv.screensaver", "com.xiaomi.mitv.hyper.screensaver", SETUPWRAITH].filter(p => p && st.installed.has(p)))];
  const reads = [
    ["getprop.txt", "getprop"],
    ["packages-f.txt", "pm list packages -f"], ["packages-disabled.txt", "pm list packages -d"], ["packages-third-party.txt", "pm list packages -3"],
    ["packages-system.txt", "pm list packages -s"], ["packages-enabled.txt", "pm list packages -e"], ["packages-all-u.txt", "pm list packages -u"],
    ["packages-versions.txt", "pm list packages --show-versioncode"],
    ["settings-global.txt", "settings list global"], ["settings-secure.txt", "settings list secure"], ["settings-system.txt", "settings list system"],
    ["home-resolve.txt", "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME"],
    ["home-claims.txt", "cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.HOME"],
    ["dreams.txt", "dumpsys dreams"], ["webview.txt", "dumpsys webviewupdate"], ["features.txt", "pm list features"],
    ["display.txt", "dumpsys display"], ["wm-size.txt", "wm size"], ["wm-density.txt", "wm density"],
    ["meminfo-proc.txt", "cat /proc/meminfo"], ["meminfo-dumpsys.txt", "dumpsys meminfo"], ["df-data.txt", "df -h /data"], ["ps.txt", "ps -A"],
    ["top.txt", "top -b -n 1"], ["wifi.txt", "dumpsys wifi"], ["media-session.txt", "dumpsys media_session"], ["input-methods.txt", "ime list -s"],
    ...extra.map(p => [`dumpsys-package-${p}.txt`, `dumpsys package ${p}`]),
  ];
  const index = { made: new Date().toISOString(), device: ident, files: [] };
  for (const [name, cmd] of reads) {
    const r = await adb.sh(cmd, { density: cmd === "wm density" });
    fs.writeFileSync(path.join(dir, name), (r.stdout || "") + (r.code ? `\n[exit ${r.code}] ${r.stderr}` : ""));
    index.files.push({ name, cmd, bytes: Buffer.byteLength(r.stdout || ""), exit: r.code });
  }
  const shot = await adb.screencap();
  if (shot.code === 0 && Buffer.isBuffer(shot.stdout) && shot.stdout.length > 8) { fs.writeFileSync(path.join(dir, "screen.png"), shot.stdout); index.files.push({ name: "screen.png", bytes: shot.stdout.length }); }
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index, null, 2) + "\n");
  const empty = index.files.filter(f => !f.bytes).map(f => f.name);
  print(`Backup: ${path.relative(PROJECT, dir) || dir} (${index.files.length} files${empty.length ? `; empty or failed: ${empty.join(", ")}` : ""})`);
  return { ident, changes: 0, dir };
}

async function undo(adb, opt, ident, print) {
  const file = path.resolve(opt.undo);
  const log = readLog(file);
  if (!log || !Array.isArray(log.entries)) throw new Refusal(`${file} is not an undo log`);
  if (log.device && log.device.model !== ident.model) throw new Refusal(`${file} belongs to ${log.device.model}, not ${ident.model}`);
  const lastRun = opt.last ? (log.entries.filter(e => !e.undoneAt && e.status !== "failed").pop() || {}).run : null;
  let n = 0, failed = 0;
  const todo = log.entries.map((e, i) => [e, i])
    .filter(([e]) => !e.undoneAt && e.status !== "failed" && e.action !== "rollback-enable" && (!opt.last || e.run === lastRun)).reverse();
  for (const [e, i] of todo) {
    if ((e.pkg && !PKG_RE.test(e.pkg)) || (e.old && !SAFE_VALUE.test(String(e.old)))) { print(`  skipped a malformed entry ${JSON.stringify(e).slice(0, 120)}`); failed++; continue; }
    let step;
    if (e.action === "disable-user") step = { sh: `pm enable --user 0 ${e.pkg}` };
    else if (e.action === "uninstall-user") step = { sh: `cmd package install-existing --user 0 ${e.pkg}` };
    else if (e.action === "setting") step = { sh: e.old === null ? `settings delete ${e.ns} ${e.key}` : `settings put ${e.ns} ${e.key} ${e.old}` };
    else if (e.action === "density") step = { sh: e.old === null ? "wm density reset" : `wm density ${e.old}`, density: true };
    else if (e.action === "grant" && /^android\.permission\.\w+$/.test(e.perm)) step = { sh: `pm revoke ${e.pkg} ${e.perm}` };
    else if (e.action === "appops" && /^\w+$/.test(e.op) && /^\w+$/.test(e.old)) step = { sh: `appops set ${e.pkg} ${e.op} ${e.old}` };
    else if (e.action === "install" && e.wasInstalled === false && OUR_APPS[e.pkg]) step = { uninstall: e.pkg };
    else { print(`  ? unknown entry ${JSON.stringify(e)}`); failed++; continue; }
    print(`  ${opt.apply ? "UNDO" : "would undo"}: ${step.sh || `adb uninstall ${step.uninstall}`}`);
    if (!opt.apply) continue;
    if (step.uninstall === "dev.designyourtv") {
      // before our APK goes, let its tile put back a density it set (it leaves one someone else set alone)
      await adb.sh(`am start -W --activity-clear-task -n ${TILE} --ez restore true`);
      print("    (asked the Claude tile to put back any density it set)");
    }
    const r = step.uninstall ? await adb.uninstallOurs(step.uninstall) : await adb.sh(step.sh, { density: !!step.density });
    const okUn = step.uninstall ? /Success|not installed|Unknown package/i.test(r.stdout + r.stderr) : r.code === 0;
    if (!okUn) { print(`    failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`); failed++; continue; }
    log.entries[i].undoneAt = new Date().toISOString();
    writeLog(file, log);
    n++;
  }
  print(opt.apply ? `Undid ${n} change(s)${failed ? `; ${failed} could not be undone (see above)` : ""}. Reboot the TV once to be sure everything is back.` : `Dry run: ${todo.length} change(s) would be undone${opt.last ? " (the last run only)" : ""}. Add --apply.`);
  if (opt.apply && failed) throw new Refusal(`${failed} undo step(s) failed`);
  return { ident, changes: n };
}

/* ---------------- selftest: a fake TV behind a fake adb (in process) ---------------- */
function fakeTv(over = {}) {
  const tv = {
    serial: "192.168.1.200:5555",
    props: { "ro.product.manufacturer": "Xiaomi", "ro.product.brand": "Xiaomi", "ro.product.model": "MiTV-FAKE0", "ro.product.device": "fake",
      "ro.build.version.release": "14", "ro.build.version.sdk": "34", "ro.product.cpu.abilist": "armeabi-v7a,armeabi",
      "ro.build.characteristics": "tv", "ro.build.fingerprint": "Xiaomi/fake/fake:14/UKN1/1:user/release-keys", "ro.adb.secure": "1", "ro.serialno": "FAKETV0001" },
    leanback: true,
    pkgs: new Map([
      ["com.miui.tv.analytics", true], ["com.xiaomi.statistic", true], ["com.mitv.tvhome.michannel", true], ["com.xm.webcontent", true],
      ["com.mitv.tvhome.atv", true], ["com.google.android.apps.tv.launcherx", true], ["com.google.android.apps.mediashell", true],
      ["com.android.tv.settings", true], ["com.google.android.tv.remote.service", true], ["com.google.android.inputmethod.latin", true],
      ["com.google.android.webview", true], ["com.mitv.livetv", true], ["com.fake.tvinput", true], ["com.xiaomi.mitv.tvmanager", false],
      ["com.mitv.gallery", true], ["com.vendor.unknownthing", true],
    ]),
    settings: { "global window_animation_scale": "1.0", "secure default_input_method": "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME" },
    home: "com.google.android.apps.tv.launcherx/.home.HomeActivity",
    calls: [], ...over,
  };
  const run = async args => {
    tv.calls.push(args);
    const ok = stdout => ({ code: 0, stdout, stderr: "" });
    if (args[0] === "devices") return ok(`List of devices attached\n${tv.serial}\tdevice product:fake model:${tv.props["ro.product.model"]} device:fake\nR5TEST00000\tdevice model:SM_S928B\n`);
    if (args[0] === "-s" && args[2] === "exec-out" && args[3] === "screencap") return { code: 0, stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0]), stderr: "" };
    if (args[0] !== "-s" || args[2] !== "shell") return { code: 1, stdout: "", stderr: "fake adb: unexpected" };
    if (args[1] !== tv.serial) return { code: 1, stdout: "", stderr: `device '${args[1]}' not found` };
    const c = args[3];
    if (tv.onMutate && MUTATING.test(c)) tv.onMutate(c);
    let m;
    if ((m = /^getprop (\S+)$/.exec(c))) return ok((tv.props[m[1]] ?? "") + "\n");
    if (c === "pm has-feature android.software.leanback") return ok(tv.leanback ? "true\n" : "false\n");
    if (c === "pm list packages --user 0") return ok([...tv.pkgs.keys()].map(p => `package:${p}`).join("\n") + "\n");
    if (c === "pm list packages -d --user 0") return ok([...tv.pkgs].filter(([, en]) => !en).map(([p]) => `package:${p}`).join("\n") + "\n");
    if (c.startsWith("cmd package resolve-activity")) return ok(`priority=2 preferredOrder=0\n${tv.home}\n`);
    if (c.startsWith("cmd package query-activities")) return ok([tv.home, ...(tv.extraHomes || [])].join("\n") + "\n");
    if ((m = /^settings get (\w+) (\S+)$/.exec(c))) return ok((tv.settings[`${m[1]} ${m[2]}`] ?? "null") + "\n");
    if ((m = /^settings put (\w+) (\S+) (\S+)$/.exec(c))) { tv.settings[`${m[1]} ${m[2]}`] = m[3]; return ok(""); }
    if ((m = /^settings delete (\w+) (\S+)$/.exec(c))) { delete tv.settings[`${m[1]} ${m[2]}`]; return ok("Deleted 1 rows\n"); }
    if (c === "dumpsys webviewupdate") return ok("Current WebView package (name, version): (com.google.android.webview, 120.0.6099.230)\n");
    if (c === "dumpsys wifi") return ok("WifiConfiguration cname=android.uid.system:1000\n");
    if ((m = /^dumpsys package (\S+)$/.exec(c))) {
      if (!tv.pkgs.has(m[1])) return ok("Unable to find package\n");
      return ok(`Packages:\n  Package [${m[1]}] (abc):\n${m[1] === "com.fake.tvinput" ? "    requested permissions:\n      android.permission.TV_INPUT_HARDWARE\n" : ""}`);
    }
    if ((m = /^pm disable-user --user 0 (\S+)$/.exec(c))) { if (!tv.pkgs.has(m[1])) return { code: 1, stdout: "", stderr: "Unknown package" }; tv.pkgs.set(m[1], false); return ok(`Package ${m[1]} new state: disabled-user\n`); }
    if ((m = /^pm enable --user 0 (\S+)$/.exec(c))) { tv.pkgs.set(m[1], true); return ok(`Package ${m[1]} new state: enabled\n`); }
    if ((m = /^pm uninstall -k --user 0 (\S+)$/.exec(c))) { tv.pkgs.delete(m[1]); (tv.gone ||= new Set()).add(m[1]); return ok("Success\n"); }
    if ((m = /^cmd package install-existing --user 0 (\S+)$/.exec(c))) { tv.pkgs.set(m[1], true); return ok(`Package ${m[1]} installed for user: 0\n`); }
    return { code: 1, stdout: "", stderr: `fake adb: no answer for "${c}"` };
  };
  return { tv, run };
}
const snapshot = tv => JSON.stringify({ p: [...tv.pkgs].sort(), s: Object.entries(tv.settings).sort() });
const MUTATING = /^(pm (disable-user|disable|enable|uninstall|grant|revoke)|settings (put|delete)|cmd package install-existing|wm density \S|appops set)/;

// The fake TV has no foreground to read, so the selftest runs tv-guard as allow-all (tools/test/tv-guard.test.mjs covers the guard itself).
const allowGuard = async () => ({ ok: true });
async function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tv-apply-selftest-"));
  const data = {
    sources: { t: { title: "test" } },
    protected: [{ re: "^com\\.google\\.android\\.apps\\.mediashell$", why: "Chromecast" }],
    keep: [{ pkg: "com.google.android.tv.remote.service", why: "phone remote" }],
    settings: [{ ns: "global", key: "window_animation_scale", value: "0.5", tier: "safe" }],
    packages: [
      { pkg: "com.miui.tv.analytics", name: "analytics", tier: "safe", reason: "t", action: "disable", sources: ["t"] },
      { pkg: "com.xiaomi.statistic", name: "stats", tier: "safe", reason: "t", action: "disable", sources: ["t"] },
      { pkg: "com.xiaomi.mitv.tvmanager", name: "already off", tier: "safe", reason: "t", action: "disable", sources: ["t"] },
      { pkg: "com.not.installed", name: "absent", tier: "safe", reason: "t", action: "disable", sources: ["t"] },
      { pkg: "com.xm.webcontent", name: "probably", tier: "probably safe", reason: "t", action: "disable", sources: ["t"] },
      { pkg: "com.mitv.gallery", name: "USB photos", tier: "probably safe", reason: "t", action: "disable", sources: ["t"], ask: "does the owner play USB drives?" },
      { pkg: "com.fake.tvinput", name: "serves an input", tier: "safe", reason: "t", action: "disable", sources: ["t"] },
      { pkg: "com.mitv.tvhome.atv", name: "PatchWall", tier: "risky", reason: "t", requires: "home-replaced", disableOnly: true, action: "disable", sources: ["t"] },
      { pkg: "com.google.android.apps.tv.launcherx", name: "Google TV home", tier: "risky", reason: "t", requires: "home-replaced", disableOnly: true, action: "disable", sources: ["t"] },
    ],
  };
  // entries a broken data file might carry: they must be refused by the code, not just by validateData
  const badEntries = ["com.android.tv.settings", "com.google.android.apps.mediashell", "com.google.android.tv.remote.service",
    "com.google.android.inputmethod.latin", "com.mitv.livetv"].map(pkg => ({ pkg, name: "BAD ENTRY", tier: "safe", reason: "bad", action: "disable", sources: ["t"] }));
  const dataFile = path.join(tmp, "data.json");
  fs.writeFileSync(dataFile, JSON.stringify(data));
  const base = { apply: false, tier: "safe", only: null, uninstall: false, settings: false, set: [], undo: null, last: false, identify: false, max: 25,
    data: dataFile, logDir: tmp, date: "2099-01-01", serial: "192.168.1.200:5555", tvIp: "192.168.1.200", density: null, expected: EXPECTED_FILE };
  const quiet = [];
  const p = s => quiet.push(s);
  const results = [];
  const test = async (name, fn) => {
    try { const r = await fn(); results.push([name, r === true ? "PASS" : `FAIL (${r})`]); }
    catch (e) { results.push([name, `FAIL (threw ${e.message})`]); }
  };

  await test("dry run changes nothing", async () => {
    const { tv, run } = fakeTv();
    const before = snapshot(tv);
    await main({ ...base, tier: "probably" }, run, p, allowGuard);
    await main({ ...base, settings: true }, run, p, allowGuard);
    const b = await main({ ...base, backup: true, apply: true, date: "2099-01-09" }, run, p, allowGuard);   // --apply must not turn a backup into changes
    if (!fs.existsSync(path.join(b.dir, "packages-f.txt")) || !fs.existsSync(path.join(b.dir, "screen.png"))) return "backup files missing";
    const mut = tv.calls.filter(a => a[0] === "-s" && MUTATING.test(a[3] || ""));
    if (mut.length) return `ran ${mut.map(a => a[3]).join("; ")}`;
    if (snapshot(tv) !== before) return "state changed";
    if (fs.existsSync(path.join(tmp, "tv-undo-2099-01-01.json"))) return "wrote an undo log";
    return true;
  });

  await test("protected packages refused (data file and wrapper)", async () => {
    const { tv, run } = fakeTv();
    const lines = [];
    // validateData rejects a list with protected entries, so main refuses it outright
    const badFile = path.join(tmp, "bad.json");
    fs.writeFileSync(badFile, JSON.stringify({ ...data, packages: [...data.packages, ...badEntries] }));
    try { await main({ ...base, apply: true, data: badFile, date: "2099-01-02" }, run, p, allowGuard); return "a data file with protected entries was accepted"; }
    catch (e) { if (!(e instanceof Refusal)) return `threw ${e.message}`; }
    // the plan refuses them too if validation were bypassed
    // (a launcher wrongly marked "safe" with no gate is gated by the code anyway)
    const mislabelled = { pkg: "com.mitv.tvhome.atv", name: "PatchWall", tier: "safe", reason: "bad", action: "disable", sources: ["t"] };
    const st = { installed: new Set(tv.pkgs.keys()), disabled: new Set(), home: "com.google.android.apps.tv.launcherx", homeClaims: ["com.google.android.apps.tv.launcherx"], dream: null, inUse: new Map() };
    const rows = await plan(guardedAdb(run, base.serial), { ...data, packages: [...data.packages.filter(x => x.pkg !== mislabelled.pkg), mislabelled, ...badEntries] }, { ...base }, { sdk: 34 }, st);
    const leaked = rows.filter(r => r.verdict === "change" && (isHardProtected(r.pkg) || STOCK_LAUNCHERS.includes(r.pkg) || badEntries.some(b => b.pkg === r.pkg)));
    if (leaked.length) return `plan would change ${leaked.map(r => r.pkg).join(", ")}`;
    if (!rows.some(r => r.pkg === mislabelled.pkg && r.verdict === "refused" && /no replacement launcher/.test(r.why))) return "a launcher marked safe was not gated by the code";
    await main({ ...base, apply: true, date: "2099-01-02" }, run, s => lines.push(s), allowGuard);
    await main({ ...base, apply: true, tier: "risky", only: ["com.mitv.tvhome.atv"], date: "2099-01-02" }, run, s => lines.push(s), allowGuard);
    const off = [...tv.pkgs].filter(([, en]) => !en).map(([k]) => k);
    const mustStay = ["com.android.tv.settings", "com.google.android.apps.mediashell", "com.google.android.tv.remote.service",
      "com.google.android.inputmethod.latin", "com.mitv.livetv", "com.fake.tvinput", "com.mitv.tvhome.atv", "com.google.android.apps.tv.launcherx", "com.mitv.gallery"];
    const hit = mustStay.filter(k => off.includes(k));
    if (hit.length) return `disabled ${hit.join(", ")}`;
    if (!lines.some(l => /REFUSED com\.mitv\.tvhome\.atv: no replacement launcher/.test(l))) return "PatchWall (wrongly marked safe in the data) was not refused";
    if (!lines.some(l => /REFUSED com\.fake\.tvinput: it serves a TV input/.test(l))) return "no input refusal";
    if (!lines.some(l => /UNKNOWN .*com\.vendor\.unknownthing/.test(l))) return "an unknown package was not reported";
    if (!(!tv.pkgs.get("com.miui.tv.analytics") && !tv.pkgs.get("com.xiaomi.statistic"))) return "the safe ones were not applied";
    if (tv.pkgs.get("com.xm.webcontent") === false) return "a 'probably safe' package applied without --tier probably";
    await main({ ...base, apply: true, tier: "probably", date: "2099-01-02" }, run, s => lines.push(s), allowGuard);
    if (!lines.some(l => /skip\s+com\.mitv\.gallery .*waits on the owner's answer/.test(l)) || tv.pkgs.get("com.mitv.gallery") === false) return "the USB question did not hold com.mitv.gallery back";
    if (tv.pkgs.get("com.vendor.unknownthing") === false) return "an unknown package was touched";
    // dangerous verbs never leave the wrapper
    const g = guardedAdb(run, base.serial);
    for (const cmd of ["pm clear com.android.vending", "cmd package clear com.android.vending", "pm uninstall com.android.vending",
      "pm uninstall-system-updates com.android.vending", "pm uninstall --user 0 com.android.vending", "pm uninstall -k --user 0 com.android.vending",
      "pm disable-user --user 0 com.android.vending", "pm disable-user --user 0 com.google.android.apps.mediashell", "cmd package uninstall com.x.y",
      "wm density 200", "reboot", "settings put global x 1; reboot"]) {
      let blocked = false;
      try { await g.sh(cmd); } catch (e) { blocked = e instanceof Refusal; }
      if (!blocked) return `"${cmd}" was not blocked`;
    }
    for (const verb of ["kill-server", "connect", "install", "uninstall", "reboot"]) if (tv.calls.some(a => a.includes(verb))) return `${verb} reached adb`;
    let un = false; try { await g.uninstallOurs("com.android.vending"); } catch (e) { un = e instanceof Refusal; }
    if (!un) return "uninstallOurs accepted the Play Store";
    return true;
  });

  await test("wrong serial or device refused", async () => {
    const cases = [
      { serial: "R5TEST00000", tvIp: "192.168.1.200" },
      { serial: "adb-R5TEST00000-abc._adb-tls-connect._tcp", tvIp: "192.168.1.200" },
      { serial: "ZTTEST0000000000", tvIp: "192.168.1.200" },
      { serial: "192.168.1.78:5555", tvIp: "192.168.1.78" },
      { serial: "192.168.1.201:5555", tvIp: "192.168.1.200" },
      { serial: "emulator-5554", tvIp: "192.168.1.200" },
      { serial: undefined, tvIp: "192.168.1.200" },
      { serial: "192.168.1.200:5555", tvIp: undefined },
    ];
    for (const c of cases) {
      const { tv, run } = fakeTv();
      try { await main({ ...base, ...c, apply: true }, run, p, allowGuard); return `accepted ${c.serial} / ${c.tvIp}`; }
      catch (e) { if (!(e instanceof Refusal)) return `threw ${e.message}`; }
      if (tv.calls.length) return `called adb for ${c.serial}`;
    }
    // a device on the right address that is not a TV, or that is the POCO / S24 under a new address
    const variants = [
      { leanback: false, props: { ...fakeTv().tv.props, "ro.build.characteristics": "phone" } },
      { leanback: true, props: { ...fakeTv().tv.props, "ro.serialno": "ZTTEST0000000000" } },
      { leanback: true, props: { ...fakeTv().tv.props, "ro.product.model": "2311DRK48G" } },
      { leanback: true, props: { ...fakeTv().tv.props, "ro.serialno": "R5TEST00000" } },
    ];
    for (const v of variants) {
      const { tv, run } = fakeTv(v);
      try { await main({ ...base, apply: true }, run, p, allowGuard); return `accepted ${JSON.stringify(v).slice(0, 80)}`; } catch (e) { if (!(e instanceof Refusal)) return `threw ${e.message}`; }
      if (tv.calls.some(a => MUTATING.test(a[3] || ""))) return "a change reached a refused device";
    }
    return true;
  });

  await test("every change is logged before it is sent", async () => {
    const { tv, run } = fakeTv();
    const file = path.join(tmp, "tv-undo-2099-01-05.json");
    const misses = [];
    tv.onMutate = cmd => {
      const log = readLog(file);
      const last = log && log.entries[log.entries.length - 1];
      if (!last || last.status !== "pending" || !(cmd.includes(last.pkg || "\u0000") || cmd.includes(last.key || "\u0000"))) misses.push(cmd + ` (log tail: ${JSON.stringify(last)})`);
    };
    await main({ ...base, apply: true, settings: true, date: "2099-01-05" }, run, p, allowGuard);
    await main({ ...base, apply: true, tier: "probably", date: "2099-01-05" }, run, p, allowGuard);
    tv.onMutate = null;
    if (misses.length) return `not logged first: ${misses[0]}`;
    const log = readLog(file);
    if (!log.entries.length || log.entries.some(e => e.status !== "done")) return `entries not all settled: ${JSON.stringify(log.entries.map(e => e.status))}`;
    // a change the TV refuses is kept as "failed" and is not undone
    const { tv: tv2, run: run2 } = fakeTv();
    const run3 = async a => (a[3] && a[3].startsWith("pm disable-user")) ? { code: 0, stdout: "Error: java.lang.SecurityException", stderr: "" } : run2(a);
    await main({ ...base, apply: true, date: "2099-01-06" }, run3, p, allowGuard);
    const log2 = readLog(path.join(tmp, "tv-undo-2099-01-06.json"));
    if (!log2 || !log2.entries.length || log2.entries.some(e => e.status !== "failed")) return "a refused change was not marked failed";
    void tv2;
    return true;
  });

  await test("undo log round-trip", async () => {
    const { tv, run } = fakeTv();
    const before = snapshot(tv);
    const r1 = await main({ ...base, apply: true, settings: true, date: "2099-01-03" }, run, p, allowGuard);
    const r2 = await main({ ...base, apply: true, tier: "probably", uninstall: true, date: "2099-01-03" }, run, p, allowGuard);
    const r3 = await main({ ...base, apply: true, set: ["secure:screensaver_components=dev.designyourtv/.WallDream"], date: "2099-01-03" }, run, p, allowGuard);
    const log = readLog(path.join(tmp, "tv-undo-2099-01-03.json"));
    if (!log || log.entries.length !== r1.changes + r2.changes + r3.changes || log.entries.length < 5) return `log has ${log && log.entries.length} entries for ${r1.changes + r2.changes + r3.changes} changes`;
    if (!log.entries.some(e => e.action === "uninstall-user")) return "no uninstall-user entry";
    if (log.device.model !== "MiTV-FAKE0") return "model not recorded";
    if (snapshot(tv) === before) return "nothing changed";
    // --last undoes only the last run
    await main({ ...base, apply: true, last: true, undo: path.join(tmp, "tv-undo-2099-01-03.json") }, run, p, allowGuard);
    if (tv.settings["secure screensaver_components"] !== undefined) return "--last did not undo the last run";
    if (tv.pkgs.get("com.miui.tv.analytics") === true) return "--last undid an earlier run";
    const mid = snapshot(tv);
    await main({ ...base, undo: path.join(tmp, "tv-undo-2099-01-03.json") }, run, p, allowGuard);
    if (snapshot(tv) !== mid) return "undo dry run changed something";
    await main({ ...base, apply: true, undo: path.join(tmp, "tv-undo-2099-01-03.json") }, run, p, allowGuard);
    if (snapshot(tv) !== before) return `state after undo differs: ${snapshot(tv)}`;
    const other = fakeTv({ props: { ...fakeTv().tv.props, "ro.product.model": "MiTV-OTHER" } });
    try { await main({ ...base, apply: true, undo: path.join(tmp, "tv-undo-2099-01-03.json") }, other.run, p, allowGuard); return "undo ran on a different model"; }
    catch (e) { if (!(e instanceof Refusal)) return `threw ${e.message}`; }
    return true;
  });

  await test("the real tv-debloat.json is valid", async () => {
    const errs = validateData(loadData(DEFAULT_DATA));
    return errs.length ? errs.slice(0, 3).join("; ") : true;
  });

  fs.rmSync(tmp, { recursive: true, force: true });       // our own temp folder
  for (const [n, r] of results) console.log(`${r.startsWith("PASS") ? "PASS" : "FAIL"}  ${n}${r.startsWith("PASS") ? "" : `: ${r}`}`);
  const failed = results.filter(([, r]) => !r.startsWith("PASS")).length;
  console.log(failed ? `${failed} of ${results.length} failed` : `all ${results.length} passed`);
  return failed;
}

/* ---------------- entry ---------------- */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let opt;
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    // the usage is the header comment of this file, printed as it stands
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split(/\r?\n/);
    console.log(src.slice(1, src.findIndex(l => l.startsWith("import "))).map(l => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(0);
  }
  try { opt = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (opt.selftest) { selftest().then(f => process.exit(f ? 1 : 0)); }
  else main(opt, realAdb(opt.adb)).then(r => process.exit(r && r.fails ? 1 : 0)).catch(e => {
    console.error(e instanceof GateFailed ? e.message : e instanceof Refusal ? `REFUSED: ${e.message}` : `error: ${e.stack || e.message}`);
    process.exit(e instanceof GateFailed ? 4 : e instanceof Refusal ? 3 : 1);
  });
}
export { main, plan, selftest, Refusal, GateFailed, guardedAdb, parseArgs, fakeTv, mutationTarget, HARD_PROTECTED, STOCK_LAUNCHERS };
