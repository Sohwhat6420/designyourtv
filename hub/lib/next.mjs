// The "Next" card: the owner's next calendar event, from an ICS feed (Google Calendar: Settings > the owner's calendar > "Secret address
// in iCal format"). The feed's address is a secret, so it lives in a git-ignored file the owner fills in themselves:
//     hub/state/calendar.json      {"ics_url": "https://calendar.google.com/calendar/ical/.../basic.ics"}
// (see hub/calendar.example.json). Nothing here asks for, stores or prints a credential: the address is read from that file
// at call time, sent only as the request URL, and cut out of every message that leaves this module. Until the file exists
// the answer is {status:"unconfigured"}. Times come out in Singapore time (+08:00, no daylight saving).
//
// A small iCalendar reader: line unfolding, DTSTART/DTEND with TZID, UTC, floating and all-day forms, RRULE (DAILY, WEEKLY,
// MONTHLY, YEARLY with INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH), EXDATE, RECURRENCE-ID overrides, CANCELLED.
import fs from "node:fs";

export const TTL_MS = 5 * 60e3;
export const MAX_BYTES = 8 << 20;
const HOUR = 3600e3, DAY = 24 * HOUR, SGT = 8 * HOUR;
const MAX_OCCURRENCES = 2000;

// ---------- time zones ----------
const dtfCache = new Map();
function offsetAt(utcMs, tz) {                  // minutes east of UTC for an IANA zone at an instant; 0 for unknown zones
  let f = dtfCache.get(tz);
  if (!f) { try { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }); } catch { f = false; } dtfCache.set(tz, f); }
  if (!f) return 0;
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(utcMs / 1000) * 1000) / 60e3;
}
/** Wall-clock fields in `tz` -> UTC milliseconds (the offset is solved twice so a daylight-saving edge settles). */
export function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = naive - offsetAt(naive, tz) * 60e3;
  t = naive - offsetAt(t, tz) * 60e3;
  return t;
}

/** An iCalendar date or date-time (with its property parameters) -> {ms, allDay}. `tz` is the zone for floating times. */
export function parseIcsDate(value, params = {}, tz = "Asia/Singapore") {
  const v = String(value || "").trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) return { ms: zonedToUtc(+m[1], +m[2], +m[3], 0, 0, 0, tz), allDay: true, ymd: [+m[1], +m[2], +m[3]] };
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  const a = m.slice(1, 7).map(Number);
  if (m[7]) return { ms: Date.UTC(a[0], a[1] - 1, a[2], a[3], a[4], a[5]), allDay: false };
  return { ms: zonedToUtc(a[0], a[1], a[2], a[3], a[4], a[5], params.TZID || tz), allDay: false, tzid: params.TZID || tz };
}

// ---------- text -> components ----------
const unescapeText = s => String(s || "").replace(/\\([nN])/g, " ").replace(/\\([,;\\])/g, "$1").replace(/\s+/g, " ").trim();

/** ICS text -> array of VEVENT property lists [{NAME: {value, params}}], with repeated NAMEs (EXDATE) as arrays. */
export function parseIcs(text) {
  const unfolded = String(text || "").replace(/\r?\n[ \t]/g, "");
  const events = [];
  let cur = null;
  for (const line of unfolded.split(/\r?\n/)) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") { if (cur) events.push(cur); cur = null; continue; }
    if (!cur || !line) continue;
    const colon = line.indexOf(":"); if (colon < 0) continue;
    const head = line.slice(0, colon).split(";"), name = head[0].toUpperCase();
    const params = {};
    for (const p of head.slice(1)) { const i = p.indexOf("="); if (i > 0) params[p.slice(0, i).toUpperCase()] = p.slice(i + 1).replace(/^"|"$/g, ""); }
    const prop = { value: line.slice(colon + 1), params };
    if (name === "EXDATE" || name === "RDATE") (cur[name] ||= []).push(prop); else cur[name] ??= prop;
  }
  return events;
}

// ---------- recurrence ----------
const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function parseRrule(s) {
  const r = {};
  for (const part of String(s).split(";")) { const i = part.indexOf("="); if (i > 0) r[part.slice(0, i).toUpperCase()] = part.slice(i + 1); }
  r.INTERVAL = Math.max(1, parseInt(r.INTERVAL, 10) || 1);
  r.COUNT = r.COUNT ? parseInt(r.COUNT, 10) : null;
  r.byday = r.BYDAY ? r.BYDAY.split(",").map(x => { const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x.trim()); return m ? { n: m[1] ? parseInt(m[1], 10) : 0, d: WD[m[2]] } : null; }).filter(Boolean) : [];
  r.bymonthday = r.BYMONTHDAY ? r.BYMONTHDAY.split(",").map(Number).filter(Number.isFinite) : [];
  r.bymonth = r.BYMONTH ? r.BYMONTH.split(",").map(Number) : [];
  return r;
}
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dowOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

/**
 * Local calendar dates ([y, m, d]) on which a rule fires, from the start date up to `endMs` (a wall-clock UTC-style number),
 * generated period by period. Each is combined with the event's wall-clock time by the caller, so daylight saving holds.
 */
function* ruleDates(rule, start, untilWall, endWall) {
  const [sy, sm, sd] = start;
  const startWall = Date.UTC(sy, sm - 1, sd);
  let emitted = 0;
  const ok = ms => ms >= startWall && ms <= endWall && (untilWall === null || ms <= untilWall);
  const stop = ms => ms > endWall || (untilWall !== null && ms > untilWall);
  const freq = rule.FREQ;
  if (freq === "DAILY") {
    for (let i = 0; ; i += rule.INTERVAL) {
      const ms = startWall + i * DAY;
      if (stop(ms) || (rule.COUNT && emitted >= rule.COUNT)) return;
      const dt = new Date(ms), dow = dt.getUTCDay();
      if (rule.byday.length && !rule.byday.some(b => b.d === dow)) continue;
      if (rule.bymonth.length && !rule.bymonth.includes(dt.getUTCMonth() + 1)) continue;
      emitted++; if (ok(ms)) yield [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
    }
  } else if (freq === "WEEKLY") {
    const wkst = rule.WKST && WD[rule.WKST] !== undefined ? WD[rule.WKST] : 1;
    const startDow = dowOf(sy, sm, sd), back = (startDow - wkst + 7) % 7;
    const days = rule.byday.length ? rule.byday.map(b => b.d) : [startDow];
    for (let w = 0; ; w += rule.INTERVAL) {
      const weekStart = startWall - back * DAY + w * 7 * DAY;
      if (stop(weekStart)) return;
      const cand = days.map(d => weekStart + ((d - wkst + 7) % 7) * DAY).sort((a, b) => a - b);
      for (const ms of cand) {
        if (ms < startWall) continue;
        if (stop(ms) || (rule.COUNT && emitted >= rule.COUNT)) return;
        const dt = new Date(ms);
        if (rule.bymonth.length && !rule.bymonth.includes(dt.getUTCMonth() + 1)) continue;
        emitted++; if (ok(ms)) yield [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
      }
    }
  } else if (freq === "MONTHLY" || freq === "YEARLY") {
    const yearly = freq === "YEARLY";
    for (let k = 0; ; k += rule.INTERVAL) {
      const y = yearly ? sy + k : sy + Math.floor((sm - 1 + k) / 12);
      const mths = yearly ? (rule.bymonth.length ? rule.bymonth : [sm]) : [((sm - 1 + k) % 12) + 1];
      if (Date.UTC(y, 0, 1) > endWall + 366 * DAY) return;
      for (const mo of mths) {
        const dim = daysInMonth(y, mo), days = new Set();
        if (rule.byday.length) {
          for (const b of rule.byday) {
            const all = []; for (let d = 1; d <= dim; d++) if (dowOf(y, mo, d) === b.d) all.push(d);
            if (b.n === 0) all.forEach(d => days.add(d)); else { const pick = b.n > 0 ? all[b.n - 1] : all[all.length + b.n]; if (pick) days.add(pick); }
          }
        } else if (rule.bymonthday.length) rule.bymonthday.forEach(d => { const dd = d < 0 ? dim + 1 + d : d; if (dd >= 1 && dd <= dim) days.add(dd); });
        else if (sd <= dim) days.add(sd);
        for (const d of [...days].sort((a, b) => a - b)) {
          const ms = Date.UTC(y, mo - 1, d);
          if (ms < startWall) continue;
          if (stop(ms) || (rule.COUNT && emitted >= rule.COUNT)) return;
          emitted++; if (ok(ms)) yield [y, mo, d];
        }
      }
    }
  }
}

/**
 * Every event instance that overlaps [fromMs, toMs): [{start, end, allDay, title, location, uid}], sorted. Cancelled events
 * and cancelled occurrences are left out; a RECURRENCE-ID override replaces its occurrence.
 */
export function expandEvents(events, fromMs, toMs, tz = "Asia/Singapore") {
  const out = [];
  const overrides = new Map();                           // uid|original start ms -> true (the override is its own event)
  for (const e of events) if (e["RECURRENCE-ID"] && e.UID) { const r = parseIcsDate(e["RECURRENCE-ID"].value, e["RECURRENCE-ID"].params, tz); if (r) overrides.set(`${e.UID.value}|${r.ms}`, true); }

  for (const e of events) {
    if (!e.DTSTART || /^CANCELLED$/i.test(e.STATUS?.value || "")) continue;
    const s = parseIcsDate(e.DTSTART.value, e.DTSTART.params, tz); if (!s) continue;
    let dur;
    if (e.DTEND) { const en = parseIcsDate(e.DTEND.value, e.DTEND.params, tz); dur = en ? en.ms - s.ms : null; }
    if (dur == null || dur < 0) {
      const m = e.DURATION && /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(e.DURATION.value);
      dur = m ? ((+m[1] || 0) * 7 + (+m[2] || 0)) * DAY + (+m[3] || 0) * HOUR + (+m[4] || 0) * 60e3 + (+m[5] || 0) * 1000 : s.allDay ? DAY : 0;
    }
    const title = unescapeText(e.SUMMARY?.value) || "(no title)", location = unescapeText(e.LOCATION?.value) || null, uid = e.UID?.value || null;
    const push = startMs => {
      if (uid && !e["RECURRENCE-ID"] && overrides.has(`${uid}|${startMs}`)) return;
      if (startMs + dur <= fromMs || startMs >= toMs) return;
      out.push({ start: startMs, end: startMs + dur, allDay: s.allDay, title, location, uid });
    };
    const ex = new Set();
    for (const x of e.EXDATE || []) for (const v of x.value.split(",")) { const d = parseIcsDate(v, x.params, tz); if (d) ex.add(d.ms); }

    if (e.RRULE && !e["RECURRENCE-ID"]) {
      const rule = parseRrule(e.RRULE.value);
      let untilWall = null;
      if (rule.UNTIL) {
        const u = parseIcsDate(rule.UNTIL, {}, tz);
        if (u) untilWall = u.allDay ? Date.UTC(...u.ymd.map((v, i) => (i === 1 ? v - 1 : v))) : Math.floor((u.ms + offsetAt(u.ms, s.tzid || tz) * 60e3) / DAY) * DAY;
      }
      const tzid = s.tzid || tz;
      const wall = new Date(s.ms + offsetAt(s.ms, tzid) * 60e3);                   // the start's wall clock, read with getUTC*
      const startYmd = [wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate()];
      const hms = s.allDay ? [0, 0, 0] : [wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds()];
      const endWall = toMs + DAY + Math.abs(offsetAt(toMs, tzid)) * 60e3;
      let n = 0;
      for (const [y, mo, d] of ruleDates(rule, startYmd, untilWall, endWall)) {
        if (++n > MAX_OCCURRENCES) break;
        const ms = zonedToUtc(y, mo, d, hms[0], hms[1], hms[2], tzid);
        if (ex.has(ms)) continue;
        push(ms);
      }
    } else if (!ex.has(s.ms)) push(s.ms);
    for (const r of e.RDATE || []) for (const v of r.value.split(",")) { const d = parseIcsDate(v, r.params, tz); if (d) push(d.ms); }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

// ---------- the card ----------
const pad = n => String(n).padStart(2, "0");
/** UTC ms -> "2026-11-05T09:00:00+08:00" (Singapore time). */
export const sgtIso = ms => { const d = new Date(ms + SGT); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+08:00`; };
/** "Dentist: check-up at 3" -> "Dentist": a label short enough for a dock chip. */
export const shortOf = t => { const s = String(t).split(/\s*[:–—(|]\s*|\s+-\s+/)[0].trim(); return (s.length > 18 ? s.slice(0, 17).trimEnd() + "…" : s) || String(t).slice(0, 18); };

function card(ev, now) {
  return { title: ev.title, short: shortOf(ev.title), start: sgtIso(ev.start), end: sgtIso(ev.end), all_day: ev.allDay,
    location: ev.location, in_min: Math.round((ev.start - now) / 60e3), started: ev.start <= now };
}

/** ICS text -> {next, now:[], upcoming:[]}. `now` = events in progress (all-day ones too); `next` = the first one still to start. */
export function nextFromIcs(text, now = Date.now(), { horizonDays = 60, tz = "Asia/Singapore", upcoming = 5 } = {}) {
  const evs = expandEvents(parseIcs(text), now - DAY, now + horizonDays * DAY, tz).filter(e => e.end > now);
  const going = evs.filter(e => e.start <= now);
  const later = evs.filter(e => e.start > now);
  return { next: later[0] ? card(later[0], now) : null, now: going.slice(0, 5).map(e => card(e, now)), upcoming: later.slice(0, upcoming).map(e => card(e, now)) };
}

/**
 * A snapshot a Claude session writes from the Google Calendar connector, for when there is no ICS address:
 *     hub/state/calendar-snapshot.json   {"written_at": ISO, "events": [{"title", "start": ISO, "end": ISO, "all_day", "location"}]}
 * It goes stale between sessions, so the answer carries snapshot_at and stale (older than 36 hours).
 */
export const SNAPSHOT_STALE_MS = 36 * HOUR;
export function nextFromSnapshot(j, now = Date.now(), { upcoming = 5 } = {}) {
  const evs = (Array.isArray(j?.events) ? j.events : []).map(e => ({ title: String(e.title || "(no title)"), location: e.location || null,
    allDay: !!e.all_day, start: Date.parse(e.start), end: Date.parse(e.end) }))
    .filter(e => Number.isFinite(e.start) && Number.isFinite(e.end) && e.end > now).sort((a, b) => a.start - b.start);
  const later = evs.filter(e => e.start > now);
  return { next: later[0] ? card(later[0], now) : null, now: evs.filter(e => e.start <= now).slice(0, 5).map(e => card(e, now)),
    upcoming: later.slice(0, upcoming).map(e => card(e, now)) };
}
function readSnapshot(file) {
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return Array.isArray(j.events) ? j : null; } catch { return null; }
}

/** The address, taken out of any message: the whole URL, its path (where the secret sits) and its query. */
export function scrub(msg, url) {
  let s = String(msg);
  if (!url) return s;
  try { const u = new URL(url); for (const bit of [url, u.pathname.length > 8 ? u.pathname : null, u.search.length > 3 ? u.search : null]) if (bit) s = s.split(bit).join("[calendar address]"); } catch { s = s.split(url).join("[calendar address]"); }
  return s;
}

export function readConfig(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    let url = typeof j.ics_url === "string" ? j.ics_url.trim() : "";
    if (/^webcal:\/\//i.test(url)) url = "https://" + url.slice(9);
    if (!/^https:\/\//i.test(url) || /REPLACE|YOUR|<.*>/.test(url)) return { url: null, why: "ics_url is not filled in" };
    return { url, horizonDays: Math.min(366, Math.max(1, Number(j.horizon_days) || 60)), tz: typeof j.tz === "string" && j.tz ? j.tz : "Asia/Singapore" };
  } catch (e) { return { url: null, why: e.code === "ENOENT" ? "no calendar.json yet" : "calendar.json is not valid JSON" }; }
}

/**
 * The reader: config at call time, the feed fetched at most every 5 minutes with one request in flight. On a failed
 * fetch the last good answer is returned with stale:true; with none, {status:"error"}.
 */
export function createNextReader({ configFile, snapshotFile = configFile ? configFile.replace(/calendar\.json$/, "calendar-snapshot.json") : null, fetchImpl = globalThis.fetch, log = () => {}, ttlMs = TTL_MS, now = () => Date.now() } = {}) {
  let cache = null, inflight = null, last = null, retryAt = 0, lastFail = null;
  async function load(cfg) {
    const r = await fetchImpl(cfg.url, { headers: { accept: "text/calendar", "user-agent": "tv-wallpaper-hub/1.0" }, signal: AbortSignal.timeout(10e3), redirect: "follow" });
    if (!r.ok) throw new Error(`calendar HTTP ${r.status}`);
    const len = Number(r.headers?.get?.("content-length")); if (len > MAX_BYTES) throw new Error("calendar feed is too large");
    const text = await r.text();
    if (text.length > MAX_BYTES) throw new Error("calendar feed is too large");
    if (!/BEGIN:VCALENDAR/.test(text)) throw new Error("the address did not return a calendar");
    return text;
  }
  return {
    async get() {
      const cfg = readConfig(configFile);
      if (!cfg.url && snapshotFile) {
        const snap = readSnapshot(snapshotFile);
        if (snap) { const n = now(), at = Date.parse(snap.written_at) || 0;
          return (last = { status: "ok", source: "snapshot", ...nextFromSnapshot(snap, n), read_at: new Date(at).toISOString(), stale: n - at > SNAPSHOT_STALE_MS }); }
      }
      if (!cfg.url) return (last = { status: "unconfigured", why: cfg.why, setup: "put the calendar's secret iCal address in hub/state/calendar.json as {\"ics_url\": \"…\"}" });
      const t = now();
      let failed = lastFail;
      if ((!cache || cache.url !== cfg.url || t - cache.at >= ttlMs) && (inflight || t >= retryAt)) {
        inflight ??= load(cfg).then(text => { cache = { url: cfg.url, at: now(), text }; lastFail = null; return null; })
          .catch(e => { const why = scrub(e.name === "TimeoutError" ? "the calendar timed out" : e.message, cfg.url); log("warn", `next: ${why}`); retryAt = now() + 60e3; lastFail = why; return why; })
          .finally(() => { inflight = null; });
        failed = await inflight;
      }
      if (!cache || cache.url !== cfg.url) return (last = { status: "error", why: failed || "the calendar could not be read" });
      const n = now();
      return (last = { status: "ok", ...nextFromIcs(cache.text, n, { horizonDays: cfg.horizonDays, tz: cfg.tz }),
        read_at: new Date(cache.at).toISOString(), stale: n - cache.at > ttlMs * 3 });
    },
    peek: () => last,
  };
}
