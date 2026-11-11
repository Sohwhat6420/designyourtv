// Bus arrivals from LTA DataMall (Bus Arrival v3, Singapore) for the stops in hub/state/bus.json (or TV_BUS_FILE):
//   { "stops": [{ "code": "<5-digit stop code>", "name": "<what the widget calls it>" }], "exclude": ["<service no>"] }
// See examples/bus.example.json. No file means no stops. The page pins services per stop (BUS_PIN in tv-setup.html).
// The AccountKey is read from its file at call time, sent only in the request header, and never logged, returned or
// put in an error message: every message that leaves this module has the key cut out of it first.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LTA_BASE = "https://datamall2.mytransport.sg/ltaodataservice";
const STATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "state");
export const KEY_FILE = process.env.TV_LTA_KEY_FILE || path.join(STATE, "lta-datamall.key");
export const busFile = () => process.env.TV_BUS_FILE || path.join(STATE, "bus.json");
/** The configured stops and left-out services: {stops:[{code, name}], exclude:Set}. */
export function loadBusConfig(file = busFile()) {
  let j = {}; try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* none yet */ }
  const stops = (Array.isArray(j.stops) ? j.stops : []).filter(s => s && /^\d{5}$/.test(String(s.code)))
    .map(s => ({ code: String(s.code), name: String(s.name || s.code).slice(0, 40) }));
  return { stops, exclude: new Set((Array.isArray(j.exclude) ? j.exclude : []).map(String)) };
}
export const CACHE_MS = 30e3;
export const HOLD_AHEAD_MS = 60e3;    // only hold a missing bus whose ETA is still more than 60 s ahead
export const HOLD_MAX_READS = 6;      // hold for at most 6 missing readings (3 min)
export const HOLD_MAX_MS = 180e3;     // wall-clock cap matching 6 x 30 s readings
const MATCH_MS = 120e3;               // one-to-one ETA match window so normal GPS drift updates in place
const WIDE_MATCH_MS = 180e3;          // wider window to pair leftover unmatched buses under heavy ETA drift
const LOADS = new Set(["SEA", "SDA", "LSD"]);

const sortServices = list => list.sort((a, b) => (parseInt(a.no, 10) - parseInt(b.no, 10)) || a.no.localeCompare(b.no));
const minFromEta = (etaMs, nowMs) => Math.max(0, Math.round((etaMs - nowMs) / 60e3));

export function readKey(file = KEY_FILE) {
  try { return fs.readFileSync(file, "utf8").trim() || null; } catch { return null; }
}

/** One stop's DataMall reply -> {code, name, services:[{no, operator, next:[{min, eta, load, type, monitored, feature}]}]}. */
export function parseBusArrival(body, stop, now = Date.now(), exclude = new Set()) {
  let j = body;
  if (typeof body === "string") { try { j = JSON.parse(body); } catch { j = null; } }
  const services = [];
  for (const s of (j && Array.isArray(j.Services) ? j.Services : [])) {
    const no = String(s.ServiceNo ?? "").trim();
    if (!no || exclude.has(no)) continue;
    const raw = [];
    for (const n of [s.NextBus, s.NextBus2, s.NextBus3]) {
      if (!n || !n.EstimatedArrival) continue;
      const eta = Date.parse(n.EstimatedArrival);
      if (Number.isNaN(eta)) continue;
      raw.push({
        etaMs: eta,
        bus: {
          min: minFromEta(eta, now),
          eta: new Date(eta).toISOString(),
          load: LOADS.has(n.Load) ? n.Load : null,
          type: n.Type || null,
          monitored: n.Monitored !== 0,
          feature: n.Feature || null,
        },
      });
    }
    raw.sort((a, b) => a.etaMs - b.etaMs);
    services.push({ no, operator: s.Operator || null, next: raw.slice(0, 3).map(x => x.bus) });
  }
  sortServices(services);
  return { code: stop.code, name: stop.name, services };
}

function smoothNext(freshBuses, prevItems, nowMs) {
  const fresh = freshBuses.map(bus => ({
    bus,
    etaMs: Date.parse(bus.eta),
    seenAt: nowMs,
    missing: 0,
    isHeld: false,
  }));
  const pairs = [];
  for (let pi = 0; pi < prevItems.length; pi++) {
    for (let fi = 0; fi < fresh.length; fi++) {
      const diff = Math.abs(prevItems[pi].etaMs - fresh[fi].etaMs);
      if (diff <= MATCH_MS) pairs.push({ diff, pi, fi });
    }
  }
  pairs.sort((a, b) => a.diff - b.diff);
  const usedPrev = new Set(), usedFresh = new Set();
  for (const { pi, fi } of pairs) {
    if (usedPrev.has(pi) || usedFresh.has(fi)) continue;
    usedPrev.add(pi);
    usedFresh.add(fi);
  }

  // Pair leftover unmatched previous and unmatched fresh buses within a wider window (~180 s)
  // to cover heavy ETA drift beyond MATCH_MS without confusing with a vanished bus.
  const leftoverPrev = [];
  for (let pi = 0; pi < prevItems.length; pi++) {
    if (!usedPrev.has(pi)) leftoverPrev.push(pi);
  }
  const leftoverFresh = [];
  for (let fi = 0; fi < fresh.length; fi++) {
    if (!usedFresh.has(fi)) leftoverFresh.push(fi);
  }

  const widePairs = [];
  for (const pi of leftoverPrev) {
    for (const fi of leftoverFresh) {
      const diff = Math.abs(prevItems[pi].etaMs - fresh[fi].etaMs);
      if (diff <= WIDE_MATCH_MS) widePairs.push({ diff, pi, fi });
    }
  }
  widePairs.sort((a, b) => a.diff - b.diff);
  const wideMatchedPrev = new Set();
  const wideMatchedFresh = new Set();
  for (const { pi, fi } of widePairs) {
    if (wideMatchedPrev.has(pi) || wideMatchedFresh.has(fi)) continue;
    wideMatchedPrev.add(pi);
    wideMatchedFresh.add(fi);
  }

  const combined = [...fresh];
  for (let pi = 0; pi < prevItems.length; pi++) {
    if (usedPrev.has(pi)) continue;
    if (wideMatchedPrev.has(pi)) continue;
    const p = prevItems[pi];
    const missing = p.missing + 1;
    if (!p.bus.monitored) continue;
    if (fresh.some(f => Math.abs(f.etaMs - p.etaMs) <= MATCH_MS)) continue; // ambiguous: trust LTA, never duplicate
    if (p.etaMs - nowMs <= HOLD_AHEAD_MS) continue;
    if (missing > HOLD_MAX_READS || nowMs - p.seenAt > HOLD_MAX_MS) continue;
    const b = p.bus;
    const heldBus = {
      min: minFromEta(p.etaMs, nowMs),
      eta: b.eta,
      load: b.load,
      type: b.type,
      monitored: b.monitored,
      feature: b.feature,
      held: true,
    };
    combined.push({ bus: heldBus, etaMs: p.etaMs, seenAt: p.seenAt, missing, isHeld: true });
  }
  combined.sort((a, b) => (a.etaMs - b.etaMs) || (Number(a.isHeld) - Number(b.isHeld)));
  return combined.slice(0, 3);
}

/**
 * A reader for every configured stop with a 30 s cache, smoothing against transient LTA dropouts, and one request in
 * flight at a time. `stops` and `exclude` default to hub/state/bus.json, read at each refresh. `fetchImpl`, `keyReader`
 * and `now` are injectable so the tests never touch the network, the clock or the key.
 */
export function createBusReader({ fetchImpl = globalThis.fetch, keyReader = readKey, stops: fixedStops = null, exclude: fixedExclude = null, cacheMs = CACHE_MS, now = () => Date.now(), log = () => {} } = {}) {
  let cache = null, inflight = null;
  const lastByStop = new Map();
  const scrubKey = (msg, key) => (key ? String(msg).split(key).join("[key]") : String(msg));

  async function fetchStopRaw(stop, key) {
    const headers = { AccountKey: key, accept: "application/json" };
    const get = url => fetchImpl(url, { headers, signal: AbortSignal.timeout(8000) });
    let r = await get(`${LTA_BASE}/v3/BusArrival?BusStopCode=${encodeURIComponent(stop.code)}`);
    if (r.status === 404) r = await get(`${LTA_BASE}/BusArrivalv2?BusStopCode=${encodeURIComponent(stop.code)}`);
    if (r.status !== 200) throw new Error(`LTA HTTP ${r.status}`);
    return r.text();
  }

  function smoothStop(parsed, t, EXCLUDE) {
    let prevMap = lastByStop.get(parsed.code);
    if (!prevMap) { prevMap = new Map(); lastByStop.set(parsed.code, prevMap); }
    const seenNos = new Set();
    for (const svc of parsed.services) {
      seenNos.add(svc.no);
      const kept = smoothNext(svc.next, prevMap.get(svc.no)?.items || [], t);
      svc.next = kept.map(x => x.bus);
      prevMap.set(svc.no, { operator: svc.operator, items: kept });
    }
    for (const [no, prev] of [...prevMap.entries()]) {
      if (seenNos.has(no) || EXCLUDE.has(no)) continue;
      const kept = smoothNext([], prev.items, t);
      if (kept.length) {
        parsed.services.push({ no, operator: prev.operator, next: kept.map(x => x.bus) });
        prevMap.set(no, { operator: prev.operator, items: kept });
      } else {
        prevMap.delete(no);
      }
    }
    sortServices(parsed.services);
    return parsed;
  }

  async function load() {
    const cfg = fixedStops ? { stops: fixedStops, exclude: new Set(fixedExclude || []) } : loadBusConfig();
    const stops = cfg.stops, EXCLUDE = cfg.exclude;
    if (!stops.length) return { read_at: new Date(now()).toISOString(), stops: [], error: "no stops configured (hub/state/bus.json)", excluded: [] };
    const key = keyReader();
    if (!key) return { read_at: new Date(now()).toISOString(), stops: [], error: "no LTA key file", excluded: [...EXCLUDE] };
    const replies = await Promise.all(stops.map(s => fetchStopRaw(s, key).then(
      body => ({ ok: true, stop: s, body }),
      e => {
        const why = scrubKey(e.name === "TimeoutError" ? "LTA timed out" : e.message, key);
        log("warn", `bus ${s.code}: ${why}`);
        return { ok: false, stop: s, why };
      },
    )));
    const t = now();
    const out = replies.map(r => r.ok
      ? smoothStop(parseBusArrival(r.body, r.stop, t, EXCLUDE), t, EXCLUDE)
      : { code: r.stop.code, name: r.stop.name, services: [], error: r.why });
    return { read_at: new Date(t).toISOString(), stops: out, excluded: [...EXCLUDE] };
  }

  return {
    async get({ force = false } = {}) {
      const t0 = now();
      if (!force && cache && t0 - cache.at < cacheMs) return cache.data;
      inflight ??= load().then(data => { cache = { at: t0, data }; return data; }).finally(() => { inflight = null; });
      return inflight;
    },
    peek: () => cache?.data || null,
  };
}
