// The TV (tested on a Xiaomi MiTV-MOOR2, Google TV, Android 11) kept on adb, and switched on or off from the hub.
//   keeper  every 20 s (60 s while it is Asleep) one `adb -s <tv> shell dumpsys power | grep -m1 mWakefulness=`; when that fails, `adb devices`,
//           `adb disconnect <tv>` if it is listed offline, then `adb connect <tv>`, backing off (equal jitter, 2 s
//           doubling to 60 s) while it stays away. While adb is down it also asks Cast (port 8009, read-only
//           GET_STATUS) whether the TV is in standby. State goes to hub/state/tv.json.
//   on      adb KEYCODE_WAKEUP (224) when adb answers; else a Wake-on-LAN burst, reconnect and 224; else (unless told
//           not to) a Cast LAUNCH of the Default Media Receiver, stopped again once the TV is up.
//   off     adb KEYCODE_SLEEP (223): Xiaomi's STR path (PowerManager ASLEEP, reason sleep_button).
// Every adb call goes through checkAdbArgs: only the TV's own serial, only the commands above. Never `kill-server`, never
// a bare `disconnect`, never another serial (phones belong to other keepers). Same adb server as
// lib/phones.mjs. Every child process is started with windowsHide.
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import dgram from "node:dgram";
import { execFile } from "node:child_process";
import { ADB } from "./phones.mjs";
import { writeAtomic } from "./http-util.mjs";
import { castStatus, castLaunch, castStop } from "./cast.mjs";
import { check as guardCheck, FOREGROUND_CMD } from "../../tools/tv-guard.mjs";

const serial = process.env.TV_SERIAL || "192.168.1.20:5555";
export const TV = {
  serial,
  ip: serial.split(":")[0],
  mac: process.env.TV_MAC || "",          // the TV Wi-Fi MAC for Wake-on-LAN (set TV_MAC; empty = no WoL)
  broadcast: process.env.TV_BROADCAST || "192.168.1.255",
};
export const INTERVAL_MS = 20e3;
export const ASLEEP_INTERVAL_MS = 60e3;
export const BACKOFF_BASE_MS = 2e3;
export const BACKOFF_CAP_MS = 60e3;
export const RECONNECT_BASE_MS = 60e3;                     // the keeper's own `adb connect` while adb is away: 60 s doubling to 15 min
export const RECONNECT_CAP_MS = 15 * 60e3;
export const WAKE_CMD = "dumpsys power | grep -m1 mWakefulness=";
// HomeKeyService (the Home button, and the wallpaper at power-on) is an Android accessibility service. When Android kills our
// process (low memory, 5 Nov 00:11) it lists the service under "Crashed services" and NEVER rebinds it: it stays enabled in
// settings but dead, so the TV came up in Google TV (6 Nov 11:52). Toggling the setting clears that.
export const A11Y = { service: "dev.designyourtv/.HomeKeyService", label: "designyourtv Home button",
  read: "dumpsys accessibility | grep -E 'Bound services|Crashed services'", list: "settings get secure enabled_accessibility_services" };
const A11Y_PUT = /^settings put secure enabled_accessibility_services [\w./:,$-]+$/;
export const KEY = { wakeup: "input keyevent 224", sleep: "input keyevent 223" };
// "Off" = dark but awake (6 Nov: a deep sleep drops Wi-Fi, adb, Wake-on-LAN and Cast all at once, and nothing on the network
// wakes it again). Xiaomi's "Screen off": backlight 0 + power_picture_off + screen_off_control. adb stays up, `on` undoes it.
export const DARK_READ = "settings get system screen_brightness; settings get global screen_off_control";
const DARK_PUT_ONE = "settings put (?:system screen_brightness \\d{1,3}|global power_picture_off [01]|global screen_off_control [01])";
const DARK_PUT = new RegExp(`^${DARK_PUT_ONE}(?:; ${DARK_PUT_ONE})*$`);
export const darkCmd = () => "settings put system screen_brightness 0; settings put global power_picture_off 0; settings put global screen_off_control 0";
export const undarkCmd = (brightness = 102) => `settings put global screen_off_control 1; settings put global power_picture_off 1; settings put system screen_brightness ${Math.round(brightness) > 0 ? Math.min(255, Math.round(brightness)) : 102}`;
/** DARK_READ output -> { dark, brightness } (dark = screen_off_control reads 0). */
export function parseDark(text) {
  const l = String(text || "").trim().split(/\r?\n/).map(x => x.trim());
  const b = Number(l[0]), c = l[1];
  return { dark: c === "0", brightness: Number.isFinite(b) ? b : null };
}
export { FOREGROUND_CMD };
const SAVE_EVERY_MS = 5 * 60e3;                             // last_seen alone is written at most this often

// ---------- the guard ----------
/** Throws unless this adb argv is one the keeper may run, aimed at `serial` and nothing else. */
export function checkAdbArgs(args, serial = TV.serial) {
  const a = args.map(String), j = a.join(" ");
  if (/\b(kill-server|start-server|reconnect|pair|keygen|install|uninstall|tcpip|usb|root|reboot)\b/.test(a[0] || "")) throw new Error(`refused: adb ${j}`);
  if (a.length === 1 && a[0] === "devices") return a;
  if (a.length === 2 && a[0] === "devices" && a[1] === "-l") return a;
  if (a.length === 2 && (a[0] === "connect" || a[0] === "disconnect") && a[1] === serial) return a;
  if (a.length === 4 && a[0] === "-s" && a[1] === serial && a[2] === "shell" && ([WAKE_CMD, KEY.wakeup, KEY.sleep, FOREGROUND_CMD, A11Y.read, A11Y.list, DARK_READ, "settings put secure accessibility_enabled 1"].includes(a[3]) || A11Y_PUT.test(a[3]) || DARK_PUT.test(a[3]))) return a;
  throw new Error(`refused: adb ${j}`);
}

// ---------- pure parts ----------
/** `dumpsys power` (or the grep of it) -> "Awake" | "Asleep" | "Dreaming" | "Dozing" | null. */
export function parseWakefulness(text) {
  const m = /mWakefulness=(\w+)/.exec(String(text || ""));
  return m ? m[1] : null;
}

/** The TV's line in `adb devices [-l]` -> "device" | "offline" | "unauthorized" | ... | null when it isn't listed. */
export function parseDeviceState(text, serial = TV.serial) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)/.exec(line.trim());
    if (m && m[1] === serial) return m[2];
  }
  return null;
}

/** `dumpsys accessibility | grep ...` -> { bound, crashed }: is HomeKeyService running, or on Android's crashed list. */
export function parseA11y(text) {
  const t = String(text || "");
  const bound = /Bound services:\{[^\n]*designyourtv Home button/.test(t);
  const crashed = /Crashed services:\{\{?dev.designyourtv\//.test(t);
  return { bound, crashed };
}

/** The enabled-services list with ours removed, and with ours added once (other enabled services kept, in order). */
export function a11yLists(current, svc = A11Y.service) {
  const cur = String(current || "").trim();
  const others = cur && cur !== "null" ? cur.split(":").filter(x => x && x !== svc && x !== svc.replace("/.", "/dev.designyourtv.")) : [];
  return { without: others.length ? others.join(":") : "null", withOurs: [...others, svc].join(":") };
}

/** "02:00:00:00:00:01" (or with dashes, or bare) -> 6-byte Buffer; throws on anything else. */
export function parseMac(mac) {
  const hex = String(mac || "").trim().replace(/[:-]/g, "");
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) throw new Error(`bad MAC address: ${mac}`);
  return Buffer.from(hex, "hex");
}

/** The Wake-on-LAN magic packet: six 0xFF bytes, then the MAC sixteen times (102 bytes). */
export function magicPacket(mac) {
  const m = parseMac(mac), pkt = Buffer.alloc(102, 0xff);
  for (let i = 0; i < 16; i++) m.copy(pkt, 6 + i * 6);
  return pkt;
}

/** Equal jitter: half the window plus a random half; the window doubles from `base` to `cap`. Never below base/2. */
export function backoffDelay(attempt, rng = Math.random, base = BACKOFF_BASE_MS, cap = BACKOFF_CAP_MS) {
  const w = Math.min(cap, base * 2 ** Math.min(Math.max(attempt, 0), 30));
  return Math.round(w / 2 + rng() * (w / 2));
}

/** What the screen is doing, from adb's wakefulness when we have it, else Cast's standby flag. */
export function screenOf(s) {
  if (s.reachable && s.wakefulness) return s.dark ? "off" : s.wakefulness === "Awake" || s.wakefulness === "Dreaming" ? "on" : "off";   // dark = awake with the panel off
  if (s.cast && typeof s.cast.standby === "boolean") return s.cast.standby ? "off" : "on";
  return "unknown";
}

export const emptyState = (tv = TV) => ({ serial: tv.serial, ip: tv.ip, reachable: false, adb_state: null, wakefulness: null,
  screen: "unknown", last_seen: null, last_check: null, last_error: null, last_error_at: null, down_since: null, attempt: 0,
  outages: 0, cast: null, last_power: null, dark: false });

/**
 * One check's observation -> the next state. obs: {reachable, wakefulness, adb_state, error, cast}. Pure: `now` is a
 * number (ms). `changed` is true when something a screen would show changed (reachability, wakefulness, adb state).
 */
export function step(prev, obs, now) {
  const at = new Date(now).toISOString();
  const s = { ...prev, last_check: at, adb_state: obs.adb_state ?? (obs.reachable ? "device" : null) };
  if (obs.reachable) {
    Object.assign(s, { reachable: true, wakefulness: obs.wakefulness, last_seen: at, down_since: null, attempt: 0, cast: null });
  } else {
    // the last known wakefulness is kept: "Awake when last seen" is still worth showing while adb is down
    Object.assign(s, { reachable: false, last_error: obs.error || "no answer", last_error_at: at, attempt: (prev.attempt || 0) + 1,
      down_since: prev.down_since || at, outages: (prev.outages || 0) + (prev.reachable || prev.last_check === null ? 1 : 0) });
    if (obs.cast !== undefined) s.cast = obs.cast;
  }
  s.screen = screenOf(s);
  const changed = s.reachable !== prev.reachable || s.wakefulness !== prev.wakefulness || s.adb_state !== prev.adb_state || s.screen !== prev.screen;
  return { state: s, changed };
}

// ---------- the network ----------
/** This machine's IPv4 address on the TV's subnet (so a broadcast leaves on the Wi-Fi, not a VMware or Tailscale adapter). */
export function localAddressFor(ip, ifaces = os.networkInterfaces()) {
  const toInt = a => a.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  for (const i of Object.values(ifaces).flat()) {
    if (!i || i.family !== "IPv4" || i.internal || !i.netmask) continue;
    const mask = toInt(i.netmask);
    if ((toInt(i.address) & mask) === (toInt(ip) & mask)) return i.address;
  }
  return null;
}

/** A Wake-on-LAN burst: `rounds` rounds to the subnet broadcast (ports 9 and 7), 255.255.255.255:9 and the TV's own address. */
export function sendWol({ mac = TV.mac, ip = TV.ip, broadcast = TV.broadcast, rounds = 3, gapMs = 300, bindAddress = localAddressFor(ip) } = {}) {
  const pkt = magicPacket(mac);
  const targets = [[broadcast, 9], [broadcast, 7], ["255.255.255.255", 9], [ip, 9]];
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket("udp4");
    s.on("error", e => { try { s.close(); } catch { /* closed */ } reject(e); });
    s.bind({ address: bindAddress || undefined, port: 0 }, async () => {
      s.setBroadcast(true);
      let sent = 0;
      for (let r = 0; r < rounds; r++) {
        for (const [h, p] of targets) await new Promise(ok => s.send(pkt, p, h, err => { if (!err) sent++; ok(); }));
        if (r < rounds - 1) await new Promise(ok => setTimeout(ok, gapMs));
      }
      s.close();
      resolve({ sent, from: bindAddress || "any" });
    });
  });
}

/** true when something accepts a TCP connection on ip:port within `ms`. */
export function tcpProbe(ip, port, ms = 1500) {
  return new Promise(resolve => {
    const s = net.connect({ host: ip, port });
    const done = ok => { clearTimeout(t); s.destroy(); resolve(ok); };
    const t = setTimeout(() => done(false), ms);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

// ---------- the keeper ----------
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
const secs = ms => `${(ms / 1000).toFixed(1)} s`;

/**
 * {tv, adb, run, stateFile, intervalMs, log, onChange, rng, now, sleep, wol, cast:{status, launch, stop}}. Everything
 * that touches adb, the network or the clock is injectable, so the tests run it with no process and no socket.
 */
export function createTvKeeper(o = {}) {
  const tv = o.tv || TV, adb = o.adb || ADB, run = o.run || defaultRun, log = o.log || (() => {});
  const a11yHeal = o.a11yHeal === true, A11Y_EVERY_MS = o.a11yEveryMs || 60e3;
  let a11yAt = 0, woke = false, darkAt = 0, nextConnectAt = 0;
  const watcher = o.watcher || null;       // {start, stop}: the process that brings the picture back on a real remote key
  const onChange = o.onChange || (() => {}), rng = o.rng || Math.random, now = o.now || Date.now, sleep = o.sleep || sleepMs;
  // Asleep, it is looked at once a minute, not every 20 s: on Xiaomi TVs with Wake on WLAN on (network_wow=1 here),
  // owners report the set turning itself on from network traffic. TV_ASLEEP_POLL_S tunes it after the live test.
  const asleepMs = o.asleepIntervalMs || Number(process.env.TV_ASLEEP_POLL_S) * 1000 || ASLEEP_INTERVAL_MS;
  const intervalMs = o.intervalMs || INTERVAL_MS, wol = o.wol || sendWol, probe = o.probe || tcpProbe;
  const port = Number(tv.serial.split(":")[1]) || 5555;
  const cast = { status: castStatus, launch: castLaunch, stop: castStop, ...(o.cast || {}) };
  let state = { ...emptyState(tv), ...load(o.stateFile, tv) }, timer = null, busy = null, op = null, savedAt = 0, running = false;

  const adbRun = (args, timeout = 10e3) => run(adb, checkAdbArgs(args, tv.serial), timeout);
  const shell = (cmd, timeout) => adbRun(["-s", tv.serial, "shell", cmd], timeout);
  // tools/tv-guard.mjs: a key that changes the screen is only sent when our app is in front (or, for a wake, the TV is asleep).
  // `explicit` is a person asking for it (the dock button or the CLI), never an automated job. Injectable so the tests need no TV.
  const guard = o.guard || (g => guardCheck({ ...g, serial: tv.serial, adb, who: "hub-tv-power", gate: "none",
    run: (exe, args, t) => run(exe, checkAdbArgs(args, tv.serial), t) }));
  async function press(kind, opts = {}) {
    const g = await guard({ kind, explicit: opts.explicit === true });
    if (!g.ok) { const e = new Error(`⛔ TV GUARD refused ${kind}: ${g.reason}`); e.guarded = true; throw e; }
    return shell(kind === "wake" ? KEY.wakeup : KEY.sleep);
  }

  /** Dark but awake, or the picture back. Guarded as a brightness change (an explicit off may darken whatever is in front). */
  async function readDark() {
    const r = await shell(DARK_READ, 8e3);
    return parseDark(r.out);
  }
  async function setDark(dark, opts = {}) {
    const g = await guard({ kind: "brightness", explicit: opts.explicit === true });
    if (!g.ok) { const e = new Error(`⛔ TV GUARD refused ${dark ? "dark" : "undark"}: ${g.reason}`); e.guarded = true; throw e; }
    if (dark) {
      const cur = await readDark().catch(() => ({ dark: false, brightness: null }));
      if (!cur.dark) state.dark_prev_brightness = cur.brightness > 0 ? cur.brightness : (state.dark_prev_brightness || 102);
      await shell(darkCmd(), 10e3);
    } else {
      await shell(undarkCmd(state.dark_prev_brightness || 102), 10e3);
    }
    const after = await readDark();
    state.dark = after.dark; state.screen = after.dark ? "off" : "on";
    if (watcher) { try { dark ? watcher.start() : watcher.stop(); } catch (e) { log("warn", `tv: dark watcher: ${e.message}`); } }
    return after;
  }

  async function readWake() {
    const r = await shell(WAKE_CMD, 8e3);
    return parseWakefulness(r.out);                       // "Broken pipe" on stderr is dumpsys noticing grep -m1 left
  }

  /** One observation, reconnecting when adb doesn't answer. `castProbe: false` skips the Cast standby read. */
  async function observe({ reconnect = true, castProbe = true, connectMs = 12e3, gate = false } = {}) {
    let w = await readWake().catch(() => null);
    if (w) { nextConnectAt = 0; return { reachable: true, wakefulness: w, adb_state: "device" }; }
    let st = null, err = "dumpsys gave no answer";
    try { st = parseDeviceState((await adbRun(["devices"], 8e3)).out, tv.serial); } catch (e) { err = e.message; }
    // 7 Nov: a TV in deep sleep answers `adb connect` ("already connected") but not a shell, and the keeper reconnected on
    // every check (about 240 times in a day). The keeper's own checks (`gate`) now reconnect and ask Cast on a backoff that
    // grows to 15 minutes; a power command (on, reconnectFor) is never gated.
    if (gate) {
      if (now() < nextConnectAt) return { reachable: false, adb_state: st, error: "adb not answering; reconnect backing off", skipped: true };
      nextConnectAt = now() + backoffDelay(state.attempt, rng, RECONNECT_BASE_MS, RECONNECT_CAP_MS);
    }
    if (reconnect) {
      if (st === "offline" || st === "unauthorized") await adbRun(["disconnect", tv.serial], 8e3).catch(() => {});
      const c = await adbRun(["connect", tv.serial], connectMs).catch(e => ({ out: e.message }));
      const said = String(c.out || "").trim().split(/\r?\n/).pop() || "";
      w = await readWake().catch(() => null);
      if (w) return { reachable: true, wakefulness: w, adb_state: "device", reconnected: true };
      err = said ? said.slice(0, 160) : err;
      try { st = parseDeviceState((await adbRun(["devices"], 8e3)).out, tv.serial); } catch { /* keep the last */ }
    }
    let c;
    if (!castProbe) return { reachable: false, adb_state: st, error: err };
    try { const cs = await cast.status(tv.ip, { timeoutMs: 4e3 }); c = { standby: cs.standby, active_input: cs.active_input, app: cs.apps[0]?.name || null, read_at: new Date(now()).toISOString() }; }
    catch (e) { c = { standby: null, error: e.message, read_at: new Date(now()).toISOString() }; }
    return { reachable: false, adb_state: st, error: err, cast: c };
  }

  function apply(obs) {
    const prevReach = state.reachable, prevWake = state.wakefulness;
    const { state: s, changed } = step(state, obs, now());
    state = s;
    if (changed) {
      if (prevReach && !s.reachable) log("warn", `tv: adb lost (${s.last_error})`);
      else if (!prevReach && s.reachable) log("info", `tv: adb back (${s.wakefulness})`);
      // the live test's tell for Wake on WLAN waking it from our own polling (or a person with the remote)
      if (prevWake === "Asleep" && s.wakefulness === "Awake") woke = true;     // heal the Home service at once after a wake
      if (prevWake === "Asleep" && s.wakefulness === "Awake" && !op) log("info", "tv: woke without a hub command (remote, CEC or the network)");
      onChange(snapshot());
    }
    if (changed || now() - savedAt > SAVE_EVERY_MS) save();
    return s;
  }

  /** Awake and HomeKeyService not bound: toggle it off and on (the other enabled services stay). Once a minute, and at once after a wake. */
  async function healA11y(s) {
    if (!a11yHeal || !s.reachable || (s.wakefulness !== "Awake" && s.wakefulness !== "Dreaming")) return;
    if (!woke && now() - a11yAt < A11Y_EVERY_MS) return;
    woke = false; a11yAt = now();
    try {
      const st = parseA11y((await shell(A11Y.read, 8e3)).out);
      state.a11y = { bound: st.bound, crashed: st.crashed, checked_at: new Date(now()).toISOString(), heals: state.a11y?.heals || 0, healed_at: state.a11y?.healed_at || null };
      if (st.bound) return;
      const { without, withOurs } = a11yLists((await shell(A11Y.list, 8e3)).out);
      await shell(`settings put secure enabled_accessibility_services ${without}`, 8e3);
      await sleep(1500);
      await shell(`settings put secure enabled_accessibility_services ${withOurs}`, 8e3);
      await shell("settings put secure accessibility_enabled 1", 8e3);
      await sleep(2500);
      const after = parseA11y((await shell(A11Y.read, 8e3)).out);
      state.a11y = { ...state.a11y, bound: after.bound, crashed: after.crashed, heals: state.a11y.heals + 1, healed_at: new Date(now()).toISOString() };
      log(after.bound ? "warn" : "error", `tv: HomeKeyService was ${st.crashed ? "crashed" : "unbound"}; toggled it, now ${after.bound ? "bound" : "STILL unbound"}`);
      save(); onChange(snapshot());
    } catch (e) { log("warn", `tv: accessibility check: ${e.message}`); }
  }

  function save() {
    if (!o.stateFile) return;
    try { writeAtomic(o.stateFile, JSON.stringify(state, null, 1)); savedAt = now(); } catch (e) { log("warn", `tv: state file: ${e.message}`); }
  }

  /** Once a minute while awake: is the panel dark? (a real remote key may have brought the picture back, or he did it by hand) */
  async function refreshDark(s) {
    if (!s.reachable || s.wakefulness !== "Awake" || now() - darkAt < 60e3) return;
    darkAt = now();
    try {
      const d = await readDark();
      if (d.dark !== !!state.dark) {
        state.dark = d.dark; apply({ reachable: true, wakefulness: s.wakefulness }); log("info", `tv: panel is now ${d.dark ? "dark" : "lit"} (seen on check)`);
        if (!d.dark && watcher) watcher.stop();
      }
    } catch { /* the next check tries again */ }
  }

  const check = () => (busy ??= observe({ gate: true }).then(apply).then(async s => { await healA11y(s); await refreshDark(s); return s; }).catch(e => { log("error", `tv check: ${e.message}`); return state; }).finally(() => { busy = null; }));

  function schedule(ms) {
    clearTimeout(timer);
    if (!running) return;
    state.next_check_at = new Date(now() + ms).toISOString();
    timer = setTimeout(loop, ms); timer.unref?.();
  }
  async function loop() {
    if (op) return schedule(intervalMs);                    // a power command is driving adb; look again after it
    const s = await check();
    schedule(!s.reachable ? backoffDelay(s.attempt - 1, rng) : s.wakefulness === "Asleep" ? asleepMs : intervalMs);
  }

  function snapshot() {
    return { ...state, keeper: running, busy: op ? op.action : null };
  }

  // ---------- power ----------
  async function waitFor(pred, ms, every = 1500) {
    const end = now() + ms;
    for (;;) {
      const w = await readWake().catch(() => null);
      if (pred(w)) return w;
      if (now() >= end) return w;
      await sleep(every);
    }
  }

  async function on(opts) {
    const t0 = now(), steps = [];
    let s = await check();
    if (s.reachable && s.wakefulness === "Awake") {
      // "off" left it awake and dark: bring the picture back
      const d = await readDark().catch(() => ({ dark: false }));
      if (!d.dark) return { ok: true, result: "already on", via: "none", wakefulness: "Awake" };
      steps.push("picture on");
      const after = await setDark(false, opts);
      return after.dark ? { ok: false, result: "picture restore did not take (screen_off_control still 0)", via: "adb", wakefulness: "Awake", steps }
        : { ok: true, result: `picture back via adb in ${secs(now() - t0)}`, via: "adb", wakefulness: "Awake", steps };
    }
    if (opts.castOnly) return castWake(t0, steps, opts);           // the live test of the Cast path on its own
    if (s.reachable) {
      steps.push("adb wakeup");
      await press("wake");
      const w = await waitFor(x => x === "Awake", 6e3);
      if (w === "Awake") {
        apply({ reachable: true, wakefulness: w });
        if (state.dark) { steps.push("picture on"); await setDark(false, opts).catch(e => steps.push(`picture on failed: ${e.message}`)); }
        return { ok: true, result: `woke via adb in ${secs(now() - t0)}`, via: "adb", wakefulness: w, steps };
      }
    }
    // adb is away: the TV is probably in STR. Wake-on-LAN, then keep reconnecting and finish with 224.
    steps.push("wake-on-lan");
    try { const r = await wol({ mac: tv.mac, ip: tv.ip, broadcast: tv.broadcast }); steps.push(`wol sent ${r.sent} from ${r.from}`); }
    catch (e) { steps.push(`wol failed: ${e.message}`); }
    const up = await reconnectFor(opts.wolWaitMs ?? 45e3, steps, { resendWol: true });
    if (up) return { ...up, result: `woke via Wake-on-LAN + adb in ${secs(now() - t0)}`, via: "wol", steps };
    if (opts.cast === false) return { ok: false, result: `no answer to adb or Wake-on-LAN after ${secs(now() - t0)} (Cast not tried)`, via: null, steps };
    return castWake(t0, steps, opts);
  }

  async function castWake(t0, steps, opts = {}) {
    // last: a Cast LAUNCH, which Chromecast built-in answers in network standby on some TVs. Stopped again once up.
    steps.push("cast launch");
    let session = null;
    try { const r = await cast.launch(tv.ip); session = r.apps[0]?.sessionId || null; steps.push(`cast launched ${r.apps[0]?.name || "?"}`); }
    catch (e) { steps.push(`cast failed: ${e.message}`); }
    // --cast-only sends no 224 afterwards, so a pass there is the Cast LAUNCH alone
    const up2 = session ? await reconnectFor(opts.castWaitMs ?? 20e3, steps, { wakeKey: !opts.castOnly }) : null;
    if (session) await cast.stop(tv.ip, session).then(() => steps.push("cast splash stopped")).catch(e => steps.push(`cast stop failed: ${e.message}`));
    if (up2) return { ...up2, result: `woke via Cast + adb in ${secs(now() - t0)}`, via: "cast", steps };
    let cs = null; try { cs = await cast.status(tv.ip, { timeoutMs: 4e3 }); } catch { /* no answer */ }
    if (cs && cs.standby === false) return { ok: true, result: `Cast says the screen is on (adb still away) after ${secs(now() - t0)}`, via: session ? "cast" : "wol", wakefulness: null, steps };
    return { ok: false, result: `no answer to adb, Wake-on-LAN or Cast after ${secs(now() - t0)}`, via: null, steps };
  }

  /**
   * For up to `ms`: a 1.5 s TCP probe of the adb port every ~2 s, and `adb connect` only once it answers (a connect to
   * a host that is away costs 10 s or more); when adb answers, send 224 if it isn't Awake. `resendWol` repeats the
   * magic packet every 10 s; `wakeKey: false` only watches for Awake. -> {ok, wakefulness} or null.
   */
  async function reconnectFor(ms, steps, { resendWol = false, wakeKey = true } = {}) {
    const end = now() + ms;
    let lastWol = now();
    while (now() < end) {
      if (resendWol && now() - lastWol >= 10e3) { lastWol = now(); await wol({ mac: tv.mac, ip: tv.ip, broadcast: tv.broadcast }).catch(() => {}); }
      if (!(await probe(tv.ip, port, 1500))) { await sleep(2e3); continue; }
      const obs = await observe({ castProbe: false, connectMs: 6e3 }).catch(() => ({ reachable: false }));
      if (obs.reachable) {
        apply(obs);
        let w = obs.wakefulness;
        if (w !== "Awake" && wakeKey) { steps.push("adb wakeup"); await press("wake").catch(() => {}); w = await waitFor(x => x === "Awake", 6e3); }
        apply({ reachable: true, wakefulness: w || obs.wakefulness });
        if (w === "Awake") return { ok: true, wakefulness: w };
      }
      await sleep(3e3);
    }
    return null;
  }

  async function off(opts = {}) {
    const t0 = now(), steps = [];
    let s = await check();
    for (let i = 0; !s.reachable && i < 3; i++) { await sleep(3e3); s = apply(await observe()); }
    if (!s.reachable) {
      if (s.cast?.standby === true) return { ok: true, result: "already off (adb away, Cast reports standby)", via: "none", steps };
      return { ok: false, result: `adb unreachable (${s.last_error}); Cast standby: ${s.cast?.standby ?? "no answer"}`, via: null, steps };
    }
    if (s.wakefulness === "Asleep" || s.wakefulness === "Dozing") return { ok: true, result: "already off", via: "none", wakefulness: "Asleep", steps };
    if (!opts.deep) {
      // the default: dark but awake, so adb, `on` and the hub keep working while he is away
      steps.push("picture off");
      const after = await setDark(true, opts);
      return after.dark ? { ok: true, result: `screen off (dark, still awake and reachable) in ${secs(now() - t0)}`, via: "adb", wakefulness: "Awake", steps }
        : { ok: false, result: "dark did not take (screen_off_control still not 0)", via: "adb", wakefulness: "Awake", steps };
    }
    steps.push("adb sleep");
    await press("sleep", opts);
    const w = await waitFor(x => x === "Asleep" || x === null, 8e3);
    if (w === "Asleep") { apply({ reachable: true, wakefulness: w }); return { ok: true, result: `asleep via adb in ${secs(now() - t0)}`, via: "adb", wakefulness: w, steps }; }
    if (w === null) return { ok: true, result: `sleep sent; adb dropped straight after (STR), so it is probably asleep`, via: "adb", wakefulness: null, steps };
    return { ok: false, result: `sleep sent but it still reads ${w}`, via: "adb", wakefulness: w, steps };
  }

  async function power(action, opts = {}) {
    if (action === "status") { await check(); return { ok: true, action, result: statusLine(snapshot()), ...snapshot() }; }
    if (action !== "on" && action !== "off") return { ok: false, action, result: "action must be on, off or status" };
    if (op) return { ok: false, action, busy: true, result: `a "${op.action}" is already running (since ${op.at})` };
    op = { action, at: new Date(now()).toISOString() };
    const t0 = now();
    try {
      if (busy) await busy;
      const r = action === "on" ? await on(opts) : await off(opts);
      state.last_power = { action, ok: r.ok, via: r.via, result: r.result, at: op.at, ms: now() - t0 };
      save();
      log(r.ok ? "info" : "warn", `tv ${action}: ${r.result}${r.steps ? ` [${r.steps.join(", ")}]` : ""}`);
      onChange(snapshot());
      return { action, ...r, ms: now() - t0, screen: state.screen };
    } catch (e) {
      log("error", `tv ${action}: ${e.message}`);
      return { ok: false, action, result: `failed: ${e.message}`, ms: now() - t0 };
    } finally { op = null; }
  }

  return {
    snapshot, check, power,
    refresh: async () => { await check(); return snapshot(); },
    start() { if (!running) { running = true; loop(); } return this; },
    stop() { running = false; clearTimeout(timer); timer = null; },
  };
}

/** One line a Claude session can relay as it is. */
export function statusLine(s) {
  const ago = t => { if (!t) return "never"; const d = Math.max(0, Math.round((Date.now() - Date.parse(t)) / 1000)); return d < 90 ? `${d} s ago` : d < 5400 ? `${Math.round(d / 60)} min ago` : `${(d / 3600).toFixed(1)} h ago`; };
  const scr = s.screen === "on" ? "ON" : s.screen === "off" ? "OFF" : "unknown";
  if (s.reachable) return `TV is ${scr} (${s.wakefulness}); adb reachable, checked ${ago(s.last_check)}`;
  const c = s.cast ? (s.cast.standby === null ? "Cast no answer" : `Cast says ${s.cast.standby ? "standby" : `on${s.cast.app ? `, ${s.cast.app}` : ""}`}`) : "Cast not asked";
  return `TV is ${scr}; adb UNREACHABLE since ${s.down_since || "?"} (${s.last_error || "no answer"}), last seen ${ago(s.last_seen)} ${s.wakefulness ? `as ${s.wakefulness}` : ""}; ${c}`.replace(/\s+;/, ";");
}

function load(file, tv) {
  if (!file) return {};
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    // only what survives a restart honestly: when it was last seen, the outage count and the last power command
    return s && s.serial === tv.serial ? { last_seen: s.last_seen ?? null, outages: s.outages ?? 0, last_power: s.last_power ?? null, wakefulness: s.wakefulness ?? null } : {};
  } catch { return {}; }
}

/** adb, windowless. Resolves {code, out, err} whatever the exit code (adb's exit codes are not reliable); rejects only when it can't run. */
function defaultRun(exe, args, timeout = 10e3) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { windowsHide: true, timeout, encoding: "utf8", maxBuffer: 4 << 20 }, (err, out, errOut) => {
      if (err && err.code === "ENOENT") return reject(new Error("adb not found"));
      if (err && err.killed) return reject(new Error("adb timed out"));
      resolve({ code: err ? err.code ?? 1 : 0, out: String(out || ""), err: String(errOut || "") });
    });
  });
}
