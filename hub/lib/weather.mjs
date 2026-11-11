// NEA's 2-hour forecast for one Singapore area (data.gov.sg, open data, no key). For the travel laptop's widget, beside
// "waiting on you". The area is the page's setting; TV_WEATHER_AREA is the default.
export const NEA_URL = "https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast";
export const TTL_MS = 10 * 60e3;

/** The reply -> {area, forecast, valid_text, valid_to, issued_at} for one area (case-insensitive), or null. */
export function parseForecast(body, area) {
  const j = typeof body === "string" ? JSON.parse(body) : body;
  const it = j && j.data && Array.isArray(j.data.items) ? j.data.items[0] : null;
  if (!it || !Array.isArray(it.forecasts)) return null;
  const f = it.forecasts.find(x => String(x.area).toLowerCase() === String(area).toLowerCase());
  if (!f) return null;
  const v = it.valid_period || {};
  return { area: f.area, forecast: f.forecast, valid_text: v.text || null, valid_to: v.end || null, issued_at: it.timestamp || it.update_timestamp || null };
}

export function createWeatherReader({ fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  let cache = { at: 0, body: null, inflight: null };
  async function body(now) {
    if (cache.body && now - cache.at < TTL_MS) return cache.body;
    cache.inflight ??= fetchImpl(NEA_URL, { signal: AbortSignal.timeout(6000) })
      .then(r => { if (!r.ok) throw new Error(`NEA HTTP ${r.status}`); return r.json(); })
      .then(j => { cache = { at: Date.now(), body: j, inflight: null }; return j; })
      .catch(e => { cache.inflight = null; log("warn", `weather: ${e.message}`); if (cache.body) return cache.body; throw e; });
    return cache.inflight;
  }
  return {
    async get(area = process.env.TV_WEATHER_AREA || "City", now = Date.now()) {
      try {
        const f = parseForecast(await body(now), area);
        return f ? { ...f, read_at: new Date(cache.at).toISOString(), stale: now - cache.at > TTL_MS * 3 } : { available: false, why: `no area "${area}"` };
      } catch (e) { return { available: false, why: e.message }; }
    },
  };
}
