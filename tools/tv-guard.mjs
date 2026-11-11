#!/usr/bin/env node
// tv-guard: nothing may change what is on the bedroom TV's screen unless OUR app (or the launcher that hosts it) is in front.
// Why (6 Nov 2026): the 4 Nov measuring lane saw YouTube in front at 19:59, then sent HOME, `am start`ed our HomeActivity
// and `am force-stop`ped com.google.android.youtube.tv at 20:03, with injected keys and a page reload around it. He was watching.
// This is the one gate every lane, tool and hub/lib/tv-power.mjs goes through before an adb action that touches the screen.
//
//   node tools/tv-guard.mjs status                          what is in front now (read-only)
//   node tools/tv-guard.mjs check --who <lane> [--kind <k>] exit 0 = go ahead, 9 = refused (reason on stderr)
//   node tools/tv-guard.mjs adb --who <lane> -- <adb args>  classify, guard if it is screen-changing, then run it
//   kinds: input launch home stop reload install display brightness power sleep wake setting unknown
//
// It reads `dumpsys activity activities` (mResumedActivity and mFocusedApp) and refuses unless EVERY foreground package is ours
// or launcherx. It fails closed: an unreadable or unparseable answer is a refusal (only `wake` fails open, since a wake key
// never changes the foreground). It also refuses force-stopping any other app whatever is in front, and refuses
// screen-changing actions between 18:00 and 01:00 SGT (when he watches) unless he allowed it in devices/tv-guard-allow.json
// or TV_GUARD_ALLOW_EVENING=1. Every verdict is appended to devices/tv-guard.log. Read-only commands are never gated.
// Every child process is windowsHide; nothing here pops a window.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
export const SERIAL = process.env.TV_SERIAL || "192.168.1.20:5555";
// Ours, plus the HOME screens (nobody is watching a home screen): launcherx, and the stock launchers a fresh TV sits on before our
// app is installed (Xiaomi PatchWall, the AOSP TV launcher), so the public installer's first run is not refused. Only
// dev.designyourtv may ever be force-stopped. No streaming, video or music app is ever on this list.
export const OUR_PACKAGES = ["dev.designyourtv", "com.google.android.apps.tv.launcherx", "com.mitv.tvhome.atv", "com.google.android.tvlauncher"];
export const EVENING = { from: 18, to: 1 };                      // SGT hours: [18:00, 01:00)
export const REFUSED_EXIT = 9;
const logFile = () => process.env.TV_GUARD_LOG || path.join(PROJECT, "devices", "tv-guard.log");
const allowFile = () => process.env.TV_GUARD_ALLOW || path.join(PROJECT, "devices", "tv-guard-allow.json");

function findAdb() {
  if (process.env.TV_ADB) return process.env.TV_ADB;
  const real = path.join(os.homedir(), "AppData", "Local", "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Local", "Android", "Sdk", "platform-tools", "adb.exe");
  const sdk = path.join(os.homedir(), "AppData", "Local", "Android", "Sdk", "platform-tools", "adb.exe");
  return [sdk, real].find(p => fs.existsSync(p)) || "adb";
}
export const ADB = findAdb();

// ---------- reading what is in front ----------
export const FOREGROUND_CMD = `dumpsys power | grep -m1 mWakefulness=; dumpsys activity activities | grep -E "mResumedActivity|mFocusedApp"`;

/** The package of an `ActivityRecord{... u0 pkg/.Activity t12}` line. */
function pkgOf(line) {
  const m = /\bu\d+\s+([A-Za-z][\w.]*)\/\S+/.exec(line);
  return m ? m[1] : null;
}

/**
 * FOREGROUND_CMD's output -> { wakefulness, resumed, focused, packages }. `packages` is every distinct package seen on
 * a mResumedActivity or mFocusedApp line. A literal `null` (mResumedActivity: null) is not a package.
 */
export function parseForeground(text) {
  const out = { wakefulness: null, resumed: null, focused: null, packages: [] };
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if ((m = /mWakefulness=(\w+)/.exec(line))) out.wakefulness = m[1];
    else if (/mResumedActivity/.test(line) && out.resumed === null) out.resumed = pkgOf(line);
    else if (/mFocusedApp/.test(line) && out.focused === null) out.focused = pkgOf(line);
  }
  out.packages = [...new Set([out.resumed, out.focused].filter(Boolean))];
  return out;
}

export const isOurs = pkg => OUR_PACKAGES.includes(pkg);

// ---------- what a command does to the screen ----------
const READ_ONLY_SHELL = /^(dumpsys|pidof|getprop|settings\s+get|settings\s+list|pm\s+(list|path|dump|has-feature|resolve-activity)|cmd\s+(package\s+(resolve|query)|display|media_session)|cat|ls|df|ps|top|id|uname|date|echo|grep|head|tail|wc|screencap|logcat|getevent|wm\s+(size|density)\s*$|appops\s+get|content\s+query|netstat|ip|ping|uptime|free|printenv|stat|find)\b/;
const BRIGHTNESS_KEYS = /^(screen_brightness|screen_brightness_mode|picture_backlight|power_picture_off|screen_off_control|tv_picture_\w+|tv_picture_mode)$/;

/** One shell segment -> { kind, pkg? }. Anything not recognised is "unknown" (guarded). */
export function classifyShell(segment) {
  const c = segment.trim().replace(/^(sh -c\s+)?['"]?/, "").replace(/['"]$/, "").trim();
  let m;
  if (!c) return { kind: "read" };
  if ((m = /^input\s+(?:\S+\s+)*?keyevent\s+(?:\S+\s+)*?(\S+)/.exec(c)) && /^(224|KEYCODE_WAKEUP)$/i.test(m[1])) return { kind: "wake" };
  if ((m = /^input\s+(?:\S+\s+)*?keyevent\s+(?:\S+\s+)*?(\S+)/.exec(c)) && /^(223|26|KEYCODE_SLEEP|KEYCODE_POWER)$/i.test(m[1])) return { kind: "sleep" };
  if ((m = /^input\s+(?:\S+\s+)*?keyevent\s+(?:\S+\s+)*?(\S+)/.exec(c)) && /^(3|KEYCODE_HOME)$/i.test(m[1])) return { kind: "home" };
  if (/^input\b/.test(c)) return { kind: "input" };
  if ((m = /^am\s+force-stop\s+(\S+)/.exec(c))) return { kind: "stop", pkg: m[1] };
  if (/^am\s+(kill|kill-all)\b/.test(c)) return { kind: "stop", pkg: null };
  if (/^(am\s+(start|start-activity|startservice|start-service|start-foreground-service|broadcast|instrument|stack|task|display)|monkey|svc\s+power)\b/.test(c)) return { kind: /^svc/.test(c) ? "power" : "launch" };
  if (/^(pm\s+(install|uninstall|clear|disable|disable-user|enable|hide|unhide|suspend|unsuspend|set-home-activity)|cmd\s+package\s+(install|uninstall|set-home-activity))\b/.test(c)) return { kind: "install" };
  if (/^wm\s+(size|density|overscan)\s+\S/.test(c)) return { kind: "display" };
  if ((m = /^settings\s+(put|delete)\s+(\w+)\s+(\w+)/.exec(c))) return { kind: BRIGHTNESS_KEYS.test(m[3]) ? "brightness" : "setting", key: m[3] };
  if (/^(pm\s+(grant|revoke)|appops\s+set)\b/.test(c)) return { kind: "setting" };
  if (/^(reboot|poweroff|shutdown)\b/.test(c)) return { kind: "power" };
  if (READ_ONLY_SHELL.test(c)) return { kind: "read" };
  return { kind: "unknown" };
}

/** A shell string (may chain with ; && | ) -> the most restrictive classification among its segments. */
export function classifyShellLine(cmd) {
  const parts = String(cmd).split(/;|&&|\|\||\|/).map(s => s.trim()).filter(Boolean);
  const kinds = parts.map(classifyShell);
  const rank = ["read", "setting", "wake", "brightness", "display", "sleep", "input", "home", "launch", "reload", "install", "power", "unknown", "stop"];
  kinds.sort((a, b) => rank.indexOf(b.kind) - rank.indexOf(a.kind));
  return kinds[0] || { kind: "read" };
}

/** An adb argv (after any `-s <serial>`) -> { kind, pkg? } | { refuse: why }. */
export function classifyAdb(argv) {
  const a = argv.map(String);
  const i = a[0] === "-s" ? 2 : 0, verb = a[i];
  if (/^(kill-server|start-server|reconnect|pair|keygen|tcpip|usb|root|unroot|remount|disable-verity|enable-verity|sideload|bugreport)$/.test(verb || "")) return { refuse: `adb ${verb} is never run against the TV` };
  if (/^(install|install-multiple|install-multi-package)$/.test(verb)) return { kind: "install" };
  if (verb === "uninstall") return { kind: "install" };
  if (verb === "reboot") return { kind: "power" };
  if (/^(devices|connect|disconnect|get-state|get-serialno|version|forward|reverse|pull|push|logcat|wait-for-device)$/.test(verb || "")) return { kind: "read" };
  if (verb === "exec-out" || verb === "shell") {
    const rest = a.slice(i + 1).join(" ");
    return classifyShellLine(rest);
  }
  return { kind: "unknown" };
}

// ---------- the time gate ----------
/** Hour 0-23 in Singapore. */
export function sgtHour(now = Date.now()) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", hour: "2-digit", hourCycle: "h23" }).format(now));
}
export const inEvening = (now = Date.now()) => { const h = sgtHour(now); return h >= EVENING.from || h < EVENING.to; };

/** devices/tv-guard-allow.json: {"evening_until": ISO}. Written by a session only on his word, in chat. */
export function eveningAllowed(now = Date.now(), file = allowFile(), env = process.env) {
  if (env.TV_GUARD_ALLOW_EVENING === "1") return true;
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return Date.parse(j.evening_until) > now; } catch { return false; }
}

// ---------- the decision ----------
/**
 * kind + what is in front -> { ok, reason }. Pure (the I/O is in `check`).
 * fg: parseForeground() output, or null when it could not be read. opts: { pkg, explicit, now, allowEvening, lane }.
 */
export function decide(kind, fg, opts = {}) {
  const now = opts.now ?? Date.now();
  if (kind === "read") return { ok: true, reason: "read-only" };
  if (kind === "setting") return { ok: true, reason: "a setting that changes nothing on screen" };
  if (kind === "stop" && opts.pkg !== "dev.designyourtv") return { ok: false, reason: `force-stop of ${opts.pkg || "another app"}: only our own app may ever be stopped` };
  if (kind === "wake") {
    if (!fg) return { ok: true, reason: "wake key; foreground unreadable, a wake never changes it" };
    if (fg.wakefulness && fg.wakefulness !== "Awake") return { ok: true, reason: `TV is ${fg.wakefulness}; waking it changes no foreground` };
    if (fg.packages.length && fg.packages.every(isOurs)) return { ok: true, reason: "ours is in front" };
    return { ok: false, reason: `wake key while ${fg.packages.join(", ") || "something"} is in front` };
  }
  if (!fg) return { ok: false, reason: "could not read what is in front (dumpsys failed or the TV is away): refusing, fail-closed" };
  if (opts.gate !== "none" && inEvening(now) && !(opts.allowEvening ?? eveningAllowed(now))) return { ok: false, reason: `time gate: ${EVENING.from}:00-0${EVENING.to}:00 SGT is when he watches; no TV lane runs now (devices/tv-guard-allow.json lets him lift it)` };
  if (fg.wakefulness && fg.wakefulness !== "Awake") return { ok: false, reason: `TV is ${fg.wakefulness}: a ${kind} action would wake it or does nothing useful` };
  if (!fg.packages.length) return { ok: false, reason: "no resumed activity could be parsed: refusing, fail-closed" };
  // opts.allowPackages: apps the caller itself launched in this run (the launch bench). Never a way to name YouTube in advance.
  const foreign = fg.packages.filter(p => !isOurs(p) && !(opts.allowPackages || []).includes(p));
  if (foreign.length) {
    if ((kind === "sleep" || kind === "brightness") && opts.explicit) return { ok: true, reason: `explicit user power-off while ${foreign.join(", ")} is in front` };
    return { ok: false, reason: `${foreign.join(", ")} is in front (resumed=${fg.resumed}, focused=${fg.focused}): a ${kind} action is refused` };
  }
  return { ok: true, reason: `ours is in front (${fg.packages.join(", ")})` };
}

/** TV_GUARD_TEST_ALLOW=pkg,pkg: extra foreground packages the FAKE-TV test harness (tools/test/runbook-e2e.mjs) treats as fine. Never set by a lane or a tool; every verdict that used it says so in the log. */
const testAllow = () => String(process.env.TV_GUARD_TEST_ALLOW || "").split(",").map(x => x.trim()).filter(Boolean);

function appendLog(rec) {
  try { fs.mkdirSync(path.dirname(logFile()), { recursive: true }); fs.appendFileSync(logFile(), JSON.stringify(rec) + "\n"); } catch { /* the log is a record, never a reason to fail */ }
}

/** adb, windowless. Resolves {code, out, err}; rejects only when it cannot run. */
export function defaultRun(exe, args, timeout = 10e3) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { windowsHide: true, timeout, encoding: "utf8", maxBuffer: 8 << 20 }, (err, out, errOut) => {
      if (err && err.code === "ENOENT") return reject(new Error("adb not found"));
      if (err && err.killed) return reject(new Error("adb timed out"));
      resolve({ code: err ? err.code ?? 1 : 0, out: String(out || ""), err: String(errOut || "") });
    });
  });
}

/**
 * Ask the guard. o: { kind, pkg, who, serial, adb, run, now, explicit, gate, allowEvening }.
 * `run(exe, args, timeout)` is injectable (the hub's tests pass their fake). Returns { ok, kind, reason, fg } and never throws.
 */
export async function check(o = {}) {
  const kind = o.kind || "unknown", serial = o.serial || SERIAL, run = o.run || defaultRun, adb = o.adb || ADB;
  let fg = null, readErr = null;
  if (kind !== "read" && kind !== "setting") {
    try {
      const r = await run(adb, ["-s", serial, "shell", FOREGROUND_CMD], 8e3);
      const p = parseForeground(r.out);
      fg = p.wakefulness || p.packages.length ? p : null;
      if (!fg) readErr = (r.err || r.out || "empty answer").trim().slice(0, 120);
    } catch (e) { readErr = e.message; }
  }
  const v = decide(kind, fg, { ...o, allowPackages: [...(o.allowPackages || []), ...testAllow()] });
  const rec = { at: new Date(o.now ?? Date.now()).toISOString(), who: o.who || process.env.TV_GUARD_WHO || "unknown", kind, ok: v.ok, reason: v.reason,
    fg: fg ? { wake: fg.wakefulness, resumed: fg.resumed, focused: fg.focused } : readErr ? { error: readErr } : undefined, what: o.what,
    ...(testAllow().length ? { testAllow: testAllow() } : {}) };
  if (kind !== "read" && kind !== "setting") appendLog(rec);
  return { ok: v.ok, kind, reason: v.reason, fg, error: readErr };
}

/** `check` for synchronous callers (the launch bench): execFileSync, and it throws `⛔ TV GUARD ...` when refused. */
export function checkSync(o = {}) {
  const kind = o.kind || "unknown", serial = o.serial || SERIAL;
  let fg = null, readErr = null;
  if (kind !== "read" && kind !== "setting") {
    try {
      const out = execFileSync(o.adb || ADB, ["-s", serial, "shell", FOREGROUND_CMD], { windowsHide: true, encoding: "utf8", timeout: 8e3, stdio: ["ignore", "pipe", "pipe"] });
      const p = parseForeground(out);
      fg = p.wakefulness || p.packages.length ? p : null;
      if (!fg) readErr = (out || "empty answer").trim().slice(0, 120);
    } catch (e) { readErr = String(e.message).slice(0, 120); }
  }
  const v = decide(kind, fg, { ...o, allowPackages: [...(o.allowPackages || []), ...testAllow()] });
  if (kind !== "read" && kind !== "setting")
    appendLog({ at: new Date(o.now ?? Date.now()).toISOString(), who: o.who || process.env.TV_GUARD_WHO || "unknown", kind, ok: v.ok, reason: v.reason,
      fg: fg ? { wake: fg.wakefulness, resumed: fg.resumed, focused: fg.focused } : { error: readErr }, what: o.what });
  if (!v.ok) { const e = new Error(`⛔ TV GUARD refused ${kind}: ${v.reason}`); e.guard = { ok: false, kind, reason: v.reason, fg }; throw e; }
  return { ok: true, kind, reason: v.reason, fg };
}

/** For callers that want a throw: resolves when allowed, rejects with `⛔ TV GUARD ...` otherwise. */
export async function requireOk(o) {
  const r = await check(o);
  if (!r.ok) { const e = new Error(`⛔ TV GUARD refused ${r.kind}: ${r.reason}`); e.guard = r; throw e; }
  return r;
}

/** Classify an adb argv, guard it if it is screen-changing, then run it. -> {code,out,err}. */
export async function guardedAdb(argv, o = {}) {
  const c = classifyAdb(argv);
  if (c.refuse) { appendLog({ at: new Date().toISOString(), who: o.who || "unknown", kind: "refused-verb", ok: false, reason: c.refuse }); throw new Error(`⛔ TV GUARD: ${c.refuse}`); }
  await requireOk({ ...o, kind: c.kind, pkg: c.pkg, what: argv.join(" ").slice(0, 200) });
  const run = o.run || defaultRun;
  const hasSerial = argv[0] === "-s";
  return run(o.adb || ADB, hasSerial ? argv : ["-s", o.serial || SERIAL, ...argv], o.timeout || 30e3);
}

// ---------- the command line ----------
async function main(argv) {
  const cmd = argv[0];
  const flag = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
  const who = flag("--who", process.env.TV_GUARD_WHO || "cli");
  const explicit = argv.includes("--explicit-user-power");
  if (cmd === "status") {
    const r = await defaultRun(ADB, ["-s", SERIAL, "shell", FOREGROUND_CMD], 8e3).catch(e => ({ out: "", err: e.message }));
    const fg = parseForeground(r.out);
    console.log(JSON.stringify({ ...fg, ours: fg.packages.length > 0 && fg.packages.every(isOurs), evening: inEvening(), eveningAllowed: eveningAllowed(), error: fg.packages.length || fg.wakefulness ? undefined : (r.err || "no answer").trim() }, null, 1));
    return 0;
  }
  if (cmd === "check") {
    const r = await check({ kind: flag("--kind", "input"), who, explicit });
    if (r.ok) { console.log(`TV GUARD ok (${r.reason})`); return 0; }
    console.error(`⛔ TV GUARD refused ${r.kind}: ${r.reason}`); return REFUSED_EXIT;
  }
  if (cmd === "adb") {
    const i = argv.indexOf("--");
    if (i < 0) { console.error("usage: tv-guard.mjs adb --who <lane> -- <adb args>"); return 2; }
    try { const r = await guardedAdb(argv.slice(i + 1), { who, explicit }); process.stdout.write(r.out); process.stderr.write(r.err); return r.code; }
    catch (e) { console.error(e.message); return e.message.includes("TV GUARD") ? REFUSED_EXIT : 1; }
  }
  console.error("usage: tv-guard.mjs status | check --who <lane> [--kind <k>] | adb --who <lane> -- <adb args>");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then(c => process.exit(c));
