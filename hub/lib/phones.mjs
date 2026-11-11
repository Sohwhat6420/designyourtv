// Phone batteries over adb, every 5 min, so a flat phone shows up on every screen before it dies.
// The phones come from hub/state/phones.json (or the file in TV_PHONES_FILE); see examples/phones.example.json:
//   [{ "id", "name", "label", "connect": "<ip>:5555" | null, "serial", "model", "device", "wearables", "readOnly", "reminder" }]
//   connect: when the phone is not listed, one `adb connect <connect>` per poll. null: never connected to from here.
//   wearables: also read `dumpsys bluetooth_manager` (lib/wearables.mjs parses it) for watch and earbud levels, ONLY
//   if the phone is already listed, in the same poll. readOnly: never connected, paired, installed on or changed.
//   reminder: the phone hub/poco-battery.mjs reminds about (low, and fully charged). label: its short name in reminders.
// No file means no phones. Emulators are skipped. Never `adb kill-server`: other tools share the adb server.
// A phone that drops off keeps its last good reading with online:false. `low` = 25 % or less and not charging.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { parseBluetoothDump, mergeWearables } from "./wearables.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ADB = process.env.TV_ADB || "adb";
export const POLL_MS = 5 * 60e3;
export const LOW_PCT = 25;
export const phonesFile = () => process.env.TV_PHONES_FILE || path.join(HERE, "..", "state", "phones.json");

/** One phones.json entry -> a phone profile with its `match(adbRow)`. */
export function toPhone(p) {
  const host = p.connect ? String(p.connect).replace(/:\d+$/, "") : null;
  const phone = { id: String(p.id), name: String(p.name || p.id), label: p.label ? String(p.label) : null, connect: p.connect || null,
    serial: p.serial || null, model: p.model || null, device: p.device || null, wearables: !!p.wearables, readOnly: !!p.readOnly,
    reminder: !!p.reminder };
  if (phone.readOnly) phone.connect = null;
  phone.match = d => !!d && ((host && String(d.serial || "").startsWith(host + ":")) || (phone.serial && String(d.serial || "").includes(phone.serial))
    || (phone.model && d.model === phone.model) || (phone.device && d.device === phone.device));
  return phone;
}

let memo = { file: null, mtime: 0, list: [] };
/** The configured phones (re-read when the file changes). */
export function loadPhones(file = phonesFile()) {
  let st; try { st = fs.statSync(file); } catch { return []; }
  if (memo.file === file && memo.mtime === st.mtimeMs) return memo.list;
  let list = [];
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); list = (Array.isArray(j) ? j : j.phones || []).filter(p => p && p.id).map(toPhone); } catch { list = []; }
  memo = { file, mtime: st.mtimeMs, list };
  return list;
}

/** `adb devices -l` -> [{serial, state, model, device, product}], emulators dropped. */
export function parseDevices(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/).slice(1)) {
    const m = /^(\S+)\s+(\S+)(.*)$/.exec(line.trim());
    if (!m || m[1].startsWith("emulator-") || m[1] === "*") continue;
    const kv = Object.fromEntries([...m[3].matchAll(/(\w+):(\S+)/g)].map(x => [x[1], x[2]]));
    out.push({ serial: m[1], state: m[2], model: kv.model || null, device: kv.device || null, product: kv.product || null });
  }
  return out;
}

/** `dumpsys battery` -> {pct, charging, plugged, full, temp_c, status}. status 2 = charging, 5 = full. */
export function parseDumpsysBattery(text) {
  const get = k => { const m = new RegExp(`^\\s*${k}:\\s*(.+)$`, "mi").exec(String(text || "")); return m ? m[1].trim() : null; };
  if (get("level") === null) return null;
  const level = Number(get("level")), scale = Number(get("scale")) || 100, status = Number(get("status"));
  if (!Number.isFinite(level)) return null;
  const plugged = ["AC powered", "USB powered", "Wireless powered", "Dock powered"].some(k => get(k) === "true");
  const t = Number(get("temperature"));
  return { pct: Math.round(100 * level / scale), charging: status === 2, plugged, full: status === 5,
    temp_c: Number.isFinite(t) ? t / 10 : null, status: Number.isFinite(status) ? status : null };
}

export function createPhoneMonitor({ phones = loadPhones(), adb = ADB, run = defaultRun, pollMs = POLL_MS, log = () => {}, onChange = () => {}, onWearables = () => {} } = {}) {
  const PHONES = phones.map(p => (typeof p.match === "function" ? p : toPhone(p)));
  const WEAR = PHONES.find(p => p.wearables)?.id || null;
  const last = new Map(PHONES.map(p => [p.id, { id: p.id, name: p.name, pct: null, charging: null, plugged: null, temp_c: null,
    read_at: null, online: false, low: false }]));
  let timer = null, busy = null, lastKey = "", wear = null, wearKey = "";

  async function poll() {
    let list;
    try { list = parseDevices(await run(adb, ["devices", "-l"])); }
    catch (e) { log("warn", `adb devices: ${e.message}`); list = null; }
    const seen = new Set();
    for (const p of PHONES) {
      let d = list && list.find(x => x.state === "device" && p.match(x));
      if (!d && list && p.connect) {
        try {
          await run(adb, ["connect", p.connect], 10e3);
          d = parseDevices(await run(adb, ["devices", "-l"])).find(x => x.state === "device" && p.match(x));
        } catch (e) { log("warn", `adb connect ${p.id}: ${e.message}`); }
      }
      if (!d) continue;
      try {
        const b = parseDumpsysBattery(await run(adb, ["-s", d.serial, "shell", "dumpsys", "battery"]));
        if (!b) continue;
        last.set(p.id, { id: p.id, name: p.name, pct: b.pct, charging: b.charging, plugged: b.plugged, temp_c: b.temp_c,
          read_at: new Date().toISOString(), online: true, low: b.pct <= LOW_PCT && !b.charging && !b.plugged });
        seen.add(p.id);
      } catch (e) { log("warn", `adb battery ${p.id}: ${e.message}`); }
      if (p.wearables) {                                   // read-only: one more dumpsys on the phone that is already listed
        try { wear = mergeWearables(wear, parseBluetoothDump(await run(adb, ["-s", d.serial, "shell", "dumpsys", "bluetooth_manager"], 30e3)), new Date().toISOString(), true); }
        catch (e) { log("warn", `adb bluetooth ${p.id}: ${e.message}`); }
      }
    }
    if (!(WEAR && seen.has(WEAR)) && wear) wear = mergeWearables(wear, null);
    for (const [id, v] of last) if (!seen.has(id) && v.online) last.set(id, { ...v, online: false });
    const now = list_();
    const key = JSON.stringify(now.map(v => [v.id, v.pct, v.charging, v.online, v.low]));
    if (key !== lastKey) { lastKey = key; onChange(now); }
    const wk = JSON.stringify(wear && [wear.status, wear.phone_online, wear.watch && [wear.watch.pct, wear.watch.stale, wear.watch.charging], wear.buds && [wear.buds.pct, wear.buds.stale, wear.buds.charging]]);
    if (wk !== wearKey) { wearKey = wk; onWearables(wearables()); }
    return now;
  }
  const list_ = () => [...last.values()];
  const wearables = () => wear || { status: "unavailable", why: WEAR ? "the wearables phone has not been read yet" : "no wearables phone configured", phone: WEAR, phone_online: false, read_at: null, watch: null, buds: null, devices: [] };

  return {
    list: list_,
    wearables,
    poll: () => (busy ??= poll().finally(() => { busy = null; })),
    start() { if (!timer) { this.poll(); timer = setInterval(() => this.poll(), pollMs); timer.unref(); } return this; },
    stop() { clearInterval(timer); timer = null; },
  };
}

function defaultRun(exe, args, timeout = 20e3) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { windowsHide: true, timeout, encoding: "utf8", maxBuffer: 16 << 20 }, (err, out) => {
      if (err) reject(new Error(err.code === "ENOENT" ? "adb not found" : (err.killed ? "timed out" : String(err.message).split("\n")[0].slice(0, 160))));
      else resolve(out);
    });
  });
}
