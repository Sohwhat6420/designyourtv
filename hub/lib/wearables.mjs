// Galaxy Watch and Galaxy Buds battery levels, read off the S24 Ultra's Bluetooth report. READ-ONLY: the only thing ever
// run on the phone is `dumpsys bluetooth_manager` (see phones.mjs). This file only parses text and keeps the last reading.
//
// Where the numbers can live in that report (Android 12 to 16; the redacted address XX:XX:XX:XX:72:CA keeps its last two
// octets, which is how lines about one device are joined):
//   1. BluetoothDatabase "Metadata:" lines, one per bonded device, ending in
//      `custom metadata(...|model_name=..|untethered_left_battery=N|untethered_right_battery=N|untethered_case_battery=N|
//      main_battery=N|..._charging=true|device_type=..|is_untethered_headset=..)`. Format CONFIRMED on a POCO X6 Pro
//      (Android 15, all values null there: no wearable bonded). Samsung's Buds/Wearable app fills these in.
//   2. Per-device profile blocks (`BatteryStateMachine for XX:..:AB:CD:` ... `mBatteryLevel: 87`) and any other
//      `... battery level: N` line that follows a device's address. Written from the AOSP source; NOT yet seen on a real
//      wearable (the S24 was not reachable when this was built), so it is matched loosely.
//   3. `[BR/EDR] Galaxy Buds2 Pro (72CA)` bonded-device lines supply the name when the metadata has no model_name.
// -1, "null" and anything outside 0..100 mean "not reported".

const ADDR = /\b(?:[0-9A-F]{2}|XX):(?:[0-9A-F]{2}|XX):(?:[0-9A-F]{2}|XX):(?:[0-9A-F]{2}|XX):([0-9A-F]{2}):([0-9A-F]{2})\b/i;
const BATTERY_LINE = /battery[\s_]*(?:level|percent(?:age)?|pct)?\s*[:=]\s*(-?\d{1,3})\s*%?/i;
const WATCH = /watch|\bgear\b|galaxy fit|\bfit\d?\b/i;
const BUDS = /buds|earbud|airpods|\bpods\b|earphone|\bsoundcore\b|\bliberty\b|\bwf-/i;

const level = v => { const n = Number(v); return v !== null && v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : null; };
const truthy = v => /^(true|1|yes)$/i.test(String(v ?? "").trim());

/** The `key=value|key=value` list inside "custom metadata(...)" -> object (values of "null" dropped). */
export function parseMetadata(line) {
  const m = /custom metadata\(([^)]*)\)/.exec(line);
  if (!m) return null;
  const out = {};
  for (const part of m[1].split("|")) {
    const i = part.indexOf("="); if (i < 0) continue;
    const v = part.slice(i + 1).trim();
    if (v !== "null" && v !== "") out[part.slice(0, i).trim()] = v;
  }
  return out;
}

function classify(d) {
  if (d.meta_type === "Watch") return "watch";
  if (d.meta_type === "Untethered Headset" || d.untethered) return "buds";
  if (d.name && WATCH.test(d.name)) return "watch";
  if (d.name && BUDS.test(d.name)) return "buds";
  return "other";
}

/**
 * `dumpsys bluetooth_manager` text -> [{id, name, kind: "watch"|"buds"|"other", pct, left, right, case, charging, connected}]
 * for every device with a name or a battery reading. `id` is the address's last two octets ("72:CA"). `connected` is
 * true/false only when the report says so, else null.
 */
export function parseBluetoothDump(text) {
  const devs = new Map();
  const dev = id => { let d = devs.get(id); if (!d) devs.set(id, d = { id, name: null, kind: "other", pct: null, left: null, right: null, case: null, charging: null, connected: null, untethered: false, meta_type: null }); return d; };
  let ctx = null;
  const conn = (d, c) => { d.connected = c ? true : d.connected === true ? true : false; };

  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw.trim() || /^\S/.test(raw) && !ADDR.test(raw)) { ctx = null; continue; }
    const a = /^s*(?:locals+)?addresss*:/i.test(raw) ? null : ADDR.exec(raw);   // the adapter's own address is not a device
    if (!a && /^s*(?:locals+)?addresss*:/i.test(raw)) { ctx = null; continue; }
    if (a) ctx = `${a[1]}:${a[2]}`.toUpperCase();
    if (!ctx) continue;
    const d = dev(ctx);
    const rest = a ? raw.slice(a.index + a[0].length) : raw;

    const meta = parseMetadata(raw);
    if (meta) {
      if (meta.model_name) d.name ||= meta.model_name;
      if (meta.device_type) d.meta_type = meta.device_type;
      if ("untethered_left_battery" in meta || "untethered_right_battery" in meta || "untethered_case_battery" in meta || truthy(meta.is_untethered_headset)) d.untethered = true;
      d.left = level(meta.untethered_left_battery) ?? d.left;
      d.right = level(meta.untethered_right_battery) ?? d.right;
      d.case = level(meta.untethered_case_battery) ?? d.case;
      d.pct = level(meta.main_battery) ?? d.pct;
      const ch = ["untethered_left_charging", "untethered_right_charging", "untethered_case_charging", "main_charging"].filter(k => k in meta);
      if (ch.length) d.charging = ch.some(k => truthy(meta[k]));
      continue;                                             // its "profile connection policy(...)" words say nothing about now
    }

    // a bonded-device line: `ADDR [BR/EDR] Galaxy Buds2 Pro (72CA)`
    const named = /^\s*\[(?:BR\/EDR|LE|DUAL|DUMO|UNKNOWN)\]\s*(.+?)\s*(?:\([0-9A-F]{2,6}\))?\s*$/i.exec(rest);
    if (named && a) d.name ||= named[1];
    const nm = /^\s*(?:m?Name|name|Alias)\s*[:=]\s*(.+?)\s*$/i.exec(raw);
    if (nm && !/^(null|unknown)$/i.test(nm[1])) d.name ||= nm[1];

    const b = BATTERY_LINE.exec(rest) || (!a && BATTERY_LINE.exec(raw));
    if (b) { const v = level(b[1]); if (v !== null) d.pct = v; }

    let c;
    if ((c = /\b(?:is)?connected\s*[:=]\s*(true|false)\b/i.exec(raw))) conn(d, truthy(c[1]));
    else if ((c = /\b(?:m?connection)?state\s*[:=]\s*(?:STATE_)?(CONNECTED|DISCONNECTED|CONNECTING)\b/i.exec(raw))) conn(d, c[1].toUpperCase() === "CONNECTED");
  }

  const out = [];
  for (const d of devs.values()) {
    d.kind = classify(d);
    const bud = [d.left, d.right].filter(v => v !== null);
    if (d.kind === "buds" && bud.length) d.pct = Math.min(...bud);           // the ring shows the weaker bud
    if (d.kind === "other" && d.pct === null && d.left === null && d.right === null && d.case === null) continue;   // a bonded speaker with no level is noise
    out.push({ id: d.id, name: d.name, kind: d.kind, pct: d.pct, left: d.left, right: d.right, case: d.case, charging: d.charging, connected: d.connected });
  }
  return out;
}

/** The best watch and the best buds from a parsed report: connected first, then one that has a level. */
export function pickWearables(devices) {
  const best = kind => (devices || []).filter(d => d.kind === kind)
    .sort((a, b) => (b.connected === true) - (a.connected === true) || (b.pct !== null) - (a.pct !== null))[0] || null;
  return { watch: best("watch"), buds: best("buds") };
}

const view = (d, at, stale) => ({ id: d.id, name: d.name, pct: d.pct, charging: d.charging, connected: d.connected, stale,
  ...(d.kind === "buds" ? { left: d.left, right: d.right, case: d.case } : {}), read_at: at });

/**
 * Fold one reading into the last state. `devices` is null when the phone could not be read (offline, or the command
 * failed): the last levels stay, flagged stale. A device the report no longer mentions, or lists as disconnected, is
 * kept the same way, so a ring dims instead of vanishing.
 */
export function mergeWearables(prev, devices, at = new Date().toISOString(), phoneOnline = true) {
  const base = prev || { status: "unavailable", why: "the wearables phone has not been read yet", phone: "s24", phone_online: false, read_at: null, watch: null, buds: null, devices: [] };
  if (devices === null) {
    const old = k => (base[k] ? { ...base[k], stale: true } : null);
    return { ...base, phone_online: false, watch: old("watch"), buds: old("buds") };
  }
  const pick = pickWearables(devices);
  const next = k => {
    const d = pick[k];
    if (d && (d.pct !== null || !base[k])) return view(d, at, d.connected === false && d.pct !== null);
    return base[k] ? { ...base[k], stale: true } : null;
  };
  const watch = next("watch"), buds = next("buds");
  const any = watch || buds;
  return { status: any ? "ok" : "none", ...(any ? {} : { why: "no Galaxy Watch or Buds battery in the phone's Bluetooth report" }),
    phone: "s24", phone_online: phoneOnline, read_at: at, watch, buds,
    devices: devices.map(d => ({ id: d.id, name: d.name, kind: d.kind, pct: d.pct, connected: d.connected })) };
}
