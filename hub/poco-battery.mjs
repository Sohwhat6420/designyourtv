// Battery reminders for one phone: the entry in hub/state/phones.json with "reminder": true (see lib/phones.mjs and
// examples/phones.example.json). The ids "poco" and "s24" in the code and tests are the example phones.
//
//   import { createPocoBattery } from "./poco-battery.mjs";
//   const poco = createPocoBattery({ onReminder: r => sse.send("reminder", r) }).start();
//   poco.snapshot()   -> { online, pct, status, status_name, charging, plugged, temp_c, read_at, ... }
//
// Every 5 minutes: `adb devices -l`, then `adb -s <its serial> shell dumpsys battery` (execFile, windowsHide,
// 8 s timeout). Only the reminder phone is ever read: any other target, and above all a phone marked "readOnly", is
// refused before adb runs. When the reminder phone is not listed, one `adb connect <its connect address>` per poll,
// the same as lib/phones.mjs. Never `adb kill-server`, pair or install.
//
// Reminders, at most one per threshold crossing (<label> is the phone's "label", else its name):
//   low   level <= 25 % and not charging            "<label> battery 22 %: plug it in."
//   high  level >= 90 % and charging                "<label> at 91 % and charging: unplug it to spare the battery."
// Hysteresis: low re-arms once the level is back to 30 % or more; high re-arms once it falls to 85 % or less or the
// charger comes off. A reminder of the same kind also waits 30 minutes after the last one (a loose cable that
// connects and disconnects would otherwise re-arm "high" every poll). The armed state can be kept in a JSON file, so a
// hub restart does not remind again. Readings that fail keep the last good one with online:false and never remind.
//
// Delivery: onReminder (the hub sends it as an SSE "reminder" event the pages show as a toast), plus an optional
// ntfy-style push (createNtfyPush below), OFF unless TV_POCO_PUSH=1.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { ADB, parseDevices, loadPhones } from "./lib/phones.mjs";

export const POLL_MS = 5 * 60e3;
export const ADB_TIMEOUT_MS = 8000;
export const LOW_PCT = 25, LOW_REARM = 30;
export const HIGH_PCT = 90, HIGH_REARM = 85;
export const COOLDOWN_MS = 30 * 60e3;
/** The configured reminder phone, or null; and the phones that are never read or written from here. */
export const reminderPhone = () => loadPhones().find(p => p.reminder) || null;
const readOnlyPhones = () => loadPhones().filter(p => p.readOnly);
const label = () => { const t = reminderPhone(); return t ? (t.label || t.name) : "Phone"; };
const STATUS = { 1: "unknown", 2: "charging", 3: "discharging", 4: "not charging", 5: "full" };

/** True for an `adb devices -l` row that is a read-only phone, under any of its names. */
export const isS24 = d => !!d && readOnlyPhones().some(p => p.match(d));
/** True for an `adb devices -l` row that is the reminder phone (and never a read-only one). */
export const isPoco = d => { const t = reminderPhone(); return !!d && !!t && !isS24(d) && t.match(d); };

/** Refuse anything that is not the reminder phone, before adb is run. Returns the serial. */
export function assertPoco(row) {
  if (!row || !row.serial) throw new Error("no device");
  if (isS24(row)) throw new Error(`refused: the ${readOnlyPhones().find(p => p.match(row)).name} is read-only and never read or written from here`);
  if (!isPoco(row)) throw new Error(`refused: ${row.serial} is not the ${reminderPhone()?.name || "reminder phone"}`);
  if (!/^[\w.:\-]+$/.test(row.serial)) throw new Error("refused: unexpected characters in the serial");
  return row.serial;
}

/**
 * `dumpsys battery` -> {level, scale, pct, status, status_name, charging, plugged, temp_c} or null.
 * plugged is "ac" | "usb" | "wireless" | "dock" | "none", from the "X powered: true" lines, or a "plugged: N" bit field
 * (1 AC, 2 USB, 4 wireless, 8 dock) where a build prints one. charging: status 2, or plugged in and full (status 5),
 * or plugged in while the status is unknown.
 */
export function parseBattery(text) {
  const s = String(text || "");
  const get = k => { const m = new RegExp(`^\\s*${k}:\\s*(.+?)\\s*$`, "mi").exec(s); return m ? m[1] : null; };
  const level = Number(get("level"));
  if (get("level") === null || !Number.isFinite(level)) return null;
  const scale = Number(get("scale")) || 100, status = Number(get("status")), t = Number(get("temperature"));
  let plugged = "none";
  for (const [k, v] of [["AC powered", "ac"], ["USB powered", "usb"], ["Wireless powered", "wireless"], ["Dock powered", "dock"]])
    if (get(k) === "true") { plugged = v; break; }
  const bits = Number(get("plugged"));
  if (plugged === "none" && Number.isFinite(bits) && bits > 0) plugged = bits & 1 ? "ac" : bits & 2 ? "usb" : bits & 4 ? "wireless" : bits & 8 ? "dock" : "none";
  const st = Number.isFinite(status) ? status : null;
  const charging = st === 2 || (plugged !== "none" && (st === 5 || st === 1 || st === null));
  return { level, scale, pct: Math.round(100 * level / scale), status: st, status_name: STATUS[st] || "unknown",
    charging, plugged, temp_c: Number.isFinite(t) ? t / 10 : null };
}

/** The reminder rules as a pure step: (armed state, reading, now) -> {state, fire: [reminder...]}. */
export function step(state, b, now = Date.now()) {
  const s = { low: true, high: true, ...state, last: { ...(state && state.last) } };
  const fire = [];
  if (!b) return { state: s, fire };
  const may = kind => !s.last[kind] || now - s.last[kind] >= COOLDOWN_MS;
  // re-arm first, so one reading can both re-arm and (on another threshold) fire
  if (!s.low && b.pct >= LOW_REARM) s.low = true;
  if (!s.high && (b.pct <= HIGH_REARM || !b.charging)) s.high = true;
  if (s.low && b.pct <= LOW_PCT && !b.charging && may("low")) {
    s.low = false; s.last.low = now;
    fire.push({ id: "poco-battery", kind: "low", pct: b.pct, charging: b.charging, plugged: b.plugged,
      title: `${label()} battery low`, at: new Date(now).toISOString(),
      body: b.plugged === "none" ? `${label()} battery ${b.pct} %: plug it in.` : `${label()} battery ${b.pct} % and not charging on its cable: check the charger.` });
  }
  if (s.high && b.pct >= HIGH_PCT && b.charging && may("high")) {
    s.high = false; s.last.high = now;
    fire.push({ id: "poco-battery", kind: "high", pct: b.pct, charging: b.charging, plugged: b.plugged,
      title: `${label()} charged`, body: `${label()} at ${b.pct} % and charging: unplug it to spare the battery.`, at: new Date(now).toISOString() });
  }
  return { state: s, fire };
}

export function createPocoBattery({ adb = ADB, run = defaultRun, pollMs = POLL_MS, log = () => {}, onReminder = () => {},
  push = null, stateFile = null, now = () => Date.now(), connect = true } = {}) {
  let state = loadState(stateFile);
  let last = { online: false, pct: null, level: null, scale: null, status: null, status_name: null, charging: null, plugged: null,
    temp_c: null, read_at: null, error: null, serial: null };
  let timer = null, busy = null;

  async function findPoco() {
    let rows = parseDevices(await run(adb, ["devices", "-l"]));
    let d = rows.find(x => x.state === "device" && isPoco(x));
    if (!d && connect) {
      const to = reminderPhone()?.connect;
      if (to) try { await run(adb, ["connect", to]); } catch (e) { log("warn", `poco connect: ${e.message}`); }
      rows = parseDevices(await run(adb, ["devices", "-l"]));
      d = rows.find(x => x.state === "device" && isPoco(x));
    }
    return d || null;
  }

  async function poll() {
    let b = null;
    try {
      const d = await findPoco();
      if (!d) throw new Error(`the ${reminderPhone()?.name || "reminder phone"} is not on adb`);
      const serial = assertPoco(d);
      b = parseBattery(await run(adb, ["-s", serial, "shell", "dumpsys", "battery"]));
      if (!b) throw new Error("dumpsys battery gave nothing readable");
      last = { online: true, ...b, read_at: new Date(now()).toISOString(), error: null, serial };
    } catch (e) {
      last = { ...last, online: false, error: e.message };
      log("warn", `poco battery: ${e.message}`);
      return snapshot();
    }
    const r = step(state, b, now());
    state = r.state;
    if (r.fire.length) saveState(stateFile, state, log);
    for (const rem of r.fire) {
      log("info", `poco reminder: ${rem.body}`);
      try { onReminder(rem); } catch (e) { log("error", `poco onReminder: ${e.message}`); }
      if (push) Promise.resolve().then(() => push(rem)).catch(e => log("warn", `poco push: ${e.message}`));
    }
    return snapshot();
  }

  function snapshot() {
    const { serial, ...rest } = last;                  // the serial stays on this machine
    const t = reminderPhone();
    return { id: t ? t.id : "phone", name: t ? t.name : null, ...rest, low: rest.pct != null && rest.pct <= LOW_PCT && !rest.charging,
      armed: { low: state.low, high: state.high }, thresholds: { low: LOW_PCT, high: HIGH_PCT } };
  }

  return {
    snapshot,
    poll: () => (busy ??= poll().finally(() => { busy = null; })),
    start() { if (!timer) { this.poll(); timer = setInterval(() => this.poll(), pollMs); timer.unref?.(); } return this; },
    stop() { clearInterval(timer); timer = null; },
  };
}

function loadState(file) {
  if (!file) return { low: true, high: true, last: {} };
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return { low: j.low !== false, high: j.high !== false, last: j.last || {} }; }
  catch { return { low: true, high: true, last: {} }; }
}
function saveState(file, state, log) {
  if (!file) return;
  try { const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, file); }
  catch (e) { log("warn", `poco state: ${e.message}`); }
}

/**
 * An ntfy-style push, OFF unless `enabled: true`. POSTs the reminder's text to `${server}/${topic}` with Title,
 * Priority and Tags headers. The topic is read from `topicFile` (default hub/state/ntfy-topic.txt, or TV_NTFY_TOPIC_FILE)
 * and never logged. Quiet hours 23:00-08:00 at UTC+TV_TZ_OFFSET hours (default 8): a push due then is dropped (the
 * page toast still shows). Returns {sent, why}.
 */
export function createNtfyPush({ enabled = false, server = "https://ntfy.sh", topicFile = process.env.TV_NTFY_TOPIC_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), "state", "ntfy-topic.txt"),
  topic = null, fetchFn = globalThis.fetch, quiet = [23, 8], timeoutMs = 10e3 } = {}) {
  return async function push(r, now = Date.now()) {
    if (!enabled) return { sent: false, why: "off" };
    const h = new Date(now + (Number(process.env.TV_TZ_OFFSET) || 8) * 3600e3).getUTCHours();
    if (quiet && (h >= quiet[0] || h < quiet[1])) return { sent: false, why: "quiet hours" };
    let t = topic;
    if (!t) { try { t = fs.readFileSync(topicFile, "utf8").trim(); } catch { return { sent: false, why: "no topic file" }; } }
    if (!/^[\w-]{1,64}$/.test(t)) return { sent: false, why: "bad topic" };
    const res = await fetchFn(`${server.replace(/\/$/, "")}/${t}`, { method: "POST", body: r.body,
      headers: { Title: r.title, Priority: r.kind === "low" ? "high" : "default", Tags: r.kind === "low" ? "battery" : "electric_plug" },
      signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? { sent: true } : { sent: false, why: `ntfy ${res.status}` };
  };
}

function defaultRun(exe, args, timeout = ADB_TIMEOUT_MS) {
  if (args.includes("kill-server")) return Promise.reject(new Error("refused: never adb kill-server"));
  return new Promise((resolve, reject) => {
    execFile(exe, args, { windowsHide: true, timeout, encoding: "utf8" }, (err, out) => {
      if (err) reject(new Error(err.code === "ENOENT" ? "adb not found" : (err.killed ? "timed out" : String(err.message).split("\n")[0].slice(0, 160))));
      else resolve(out);
    });
  });
}
