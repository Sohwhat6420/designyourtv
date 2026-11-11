// Synced lyrics for whatever the desk laptop is playing, from LRCLIB (https://lrclib.net, free, no key, community database).
// Only the track's title, artist, album and duration ever leave the machine (as the query string of one GET), plus a
// User-Agent naming this project, as LRCLIB asks. Parsed lines are cached per track on disk under hub/cache/lyrics/,
// so a song is looked up once, not on every play.
//
//   status "synced"       lines:[{t_s, text}] sorted by time; an empty text is a gap (the page clears the line)
//   status "instrumental" LRCLIB knows the track and says it has no words
//   status "none"         nothing playing, no match, only unsynced words exist, or LRCLIB can't be reached (why says which)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const LRCLIB = "https://lrclib.net/api";
export const USER_AGENT = `tv-wallpaper-hub/1.0 (${process.env.TV_CONTACT_URL || "designyourtv"})`;   // TV_CONTACT_URL: your repo or a contact page, for the lyrics service
export const HIT_TTL_MS = 90 * 24 * 3600e3;      // words rarely change
export const MISS_TTL_MS = 12 * 3600e3;          // a miss is retried twice a day: LRCLIB picks tracks up later
export const COOLDOWN_MS = 60e3;                 // after a network failure, no LRCLIB call for a minute
const MEM_MAX = 60;

/** "[01:23.45]" style timestamps -> seconds. Accepts [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx], [mm:ss:xx] and hours. */
const TS = /\[(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/**
 * LRC text -> [{t_s, text}] sorted by time. Handles several timestamps on one line ("[00:10.00][00:50.00]chorus"),
 * [offset:+500] (milliseconds; positive = lyrics come earlier), enhanced word tags (<00:12.00> are stripped), CRLF, and
 * ignores the [ar:] [ti:] [al:] [by:] [length:] tags. Lines with a timestamp but no words are kept as gaps.
 */
export function parseLrc(text) {
  const lines = [];
  const src = String(text || "");
  const om = /^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/im.exec(src);
  const offset = om ? Number(om[1]) / 1000 : 0;
  for (const raw of src.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(TS)];
    if (!stamps.length) continue;
    const words = raw.replace(TS, "").replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, "").replace(/\s+/g, " ").trim();
    for (const s of stamps) {
      const h = s[1] ? Number(s[1]) : 0, m = Number(s[2]), sec = Number(s[3]);
      const frac = s[4] ? Number(`0.${s[4]}`) : 0;
      lines.push({ t_s: Math.max(0, Math.round((h * 3600 + m * 60 + sec + frac - offset) * 1000) / 1000), text: words });
    }
  }
  return lines.sort((a, b) => a.t_s - b.t_s);
}

/** The line to show at `pos_s`: {index, current, next} (index -1 before the first line). For the page and the tests. */
export function lineAt(lines, pos_s) {
  let lo = 0, hi = lines.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (lines[mid].t_s <= pos_s) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  return { index: idx, current: idx >= 0 ? lines[idx] : null, next: lines[idx + 1] || null };
}

/** Players add noise LRCLIB's titles don't have: " - Topic" channels, "(Official Video)", "[Lyrics]", "feat." tails. */
export function cleanTitle(t) {
  return String(t || "")
    .replace(/\s*[(\[](?:official|lyrics?|lyric video|audio|video|visuali[sz]er|remaster(?:ed)?|live|hd|hq|mv|explicit)[^)\]]*[)\]]/gi, "")
    .replace(/\s*[(\[](?:feat|ft|with)\.?[^)\]]*[)\]]/gi, "")
    .replace(/\s+-\s+(?:official|lyrics?)\b.*$/i, "")
    .replace(/\s+/g, " ").trim();
}
export const cleanArtist = a => String(a || "").replace(/\s+-\s+Topic$/i, "").replace(/\s+/g, " ").trim();

/** now-playing -> {title, artist, album, duration_s} or null when there is no usable track. Nothing else is read from it. */
export function trackOf(np) {
  if (!np || typeof np !== "object") return null;
  if (np.status && !["playing", "paused", "stopped"].includes(np.status)) return null;
  const title = String(np.title || "").trim(), artist = cleanArtist(np.artist);
  if (!title || !artist) return null;
  const d = Number(np.duration_s);
  return { title, artist, album: String(np.album || "").trim() || null, duration_s: d >= 1 && d <= 3600 ? Math.round(d) : null };
}
/** One key per track, so the page and the cache agree. Title/artist/album/duration only. */
export const keyOf = t => (t ? [t.title, t.artist, t.album || "", t.duration_s || 0].join("␟").toLowerCase() : null);

export function createLyricsReader({ fetchImpl = globalThis.fetch, cacheDir = null, log = () => {}, now = () => Date.now() } = {}) {
  const mem = new Map();          // key -> {result, at}
  const inflight = new Map();
  let cooldownUntil = 0;
  let current = null;             // the last result handed out, for a page that connects mid-song

  const fileOf = key => (cacheDir ? path.join(cacheDir, crypto.createHash("sha1").update(key).digest("hex") + ".json") : null);
  function readDisk(key) {
    const f = fileOf(key); if (!f) return null;
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      if (j.key !== key || !j.result) return null;
      const ttl = j.result.status === "none" ? MISS_TTL_MS : HIT_TTL_MS;
      return now() - j.at < ttl ? j : null;
    } catch { return null; }
  }
  function writeDisk(key, result) {
    const f = fileOf(key); if (!f) return;
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ key, at: now(), result }));
      fs.renameSync(tmp, f);
    } catch (e) { log("warn", `lyrics cache write: ${e.message}`); }
  }
  const remember = (key, result) => { mem.set(key, { result, at: now() }); if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value); };

  async function call(params) {
    const url = `${LRCLIB}/${params.path}?${new URLSearchParams(params.q)}`;
    const r = await fetchImpl(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (r.status === 404) return null;
    if (r.status === 429 || r.status === 503) {
      const wait = Number(r.headers?.get?.("retry-after")) || 60;
      cooldownUntil = now() + Math.max(wait, 1) * 1000 * 1.3;
      throw new Error(`LRCLIB HTTP ${r.status}`);
    }
    if (!r.ok) throw new Error(`LRCLIB HTTP ${r.status}`);
    if (!/json/i.test(r.headers?.get?.("content-type") || "json")) throw new Error("LRCLIB sent a non-JSON reply");
    return r.json();
  }

  /** Up to three LRCLIB calls for one track: exact, then cleaned-up and without album/duration, then a search. */
  async function lookup(t) {
    const q = { track_name: t.title, artist_name: t.artist };
    if (t.album) q.album_name = t.album;
    if (t.duration_s) q.duration = String(t.duration_s);
    let rec = await call({ path: "get", q });
    if (!rec) {
      const ct = cleanTitle(t.title);
      rec = await call({ path: "get", q: { track_name: ct || t.title, artist_name: t.artist } });
    }
    let partial = false;                       // the exact lookups said "no such track" but the search could not be asked
    if (!rec) {
      let list = null;
      try { list = await call({ path: "search", q: { track_name: cleanTitle(t.title) || t.title, artist_name: t.artist } }); }
      catch (e) { partial = true; log("warn", `lyrics search: ${e.message}`); }
      if (Array.isArray(list) && list.length) {
        // the closest length wins; a result more than 5 s off is a different recording
        const want = t.duration_s;
        const scored = list.filter(x => x && (x.syncedLyrics || x.instrumental))
          .map(x => ({ x, d: want && x.duration ? Math.abs(x.duration - want) : 0 })).filter(s => !want || s.d <= 5).sort((a, b) => a.d - b.d);
        rec = scored.length ? scored[0].x : null;
      }
    }
    return { rec, partial };
  }

  function shape(t, key, rec) {
    const base = { track: t, key, source: "lrclib", read_at: new Date(now()).toISOString() };
    if (!rec) return { status: "none", why: "no match on LRCLIB", ...base };
    if (rec.instrumental) return { status: "instrumental", id: rec.id ?? null, lines: [], ...base };
    const lines = rec.syncedLyrics ? parseLrc(rec.syncedLyrics) : [];
    if (lines.some(l => l.text)) return { status: "synced", id: rec.id ?? null, lines, ...base };
    return { status: "none", why: rec.plainLyrics ? "only unsynced words exist" : "no match on LRCLIB", ...base };
  }

  async function get(np) {
    const t = trackOf(np), key = keyOf(t);
    if (!key) return (current = { status: "none", why: "nothing is playing", lines: [], track: null, key: null });
    const m = mem.get(key);
    if (m && (m.result.status !== "none" || now() - m.at < MISS_TTL_MS)) return (current = { ...m.result, cached: true });
    const d = readDisk(key);
    if (d) { remember(key, d.result); return (current = { ...d.result, cached: true }); }
    if (now() < cooldownUntil) return (current = { status: "none", why: "LRCLIB unreachable", lines: [], track: t, key });
    if (!inflight.has(key)) {
      inflight.set(key, lookup(t).then(({ rec, partial }) => {
        const result = shape(t, key, rec);
        if (partial && !rec) return { ...result, why: "no match on LRCLIB (search unavailable)" };     // not cached: asked again next time
        writeDisk(key, result); remember(key, result);
        return result;
      }).catch(e => {
        if (cooldownUntil <= now()) cooldownUntil = now() + COOLDOWN_MS;   // a 429 has already set its own, from Retry-After
        log("warn", `lyrics: ${e.name === "TimeoutError" ? "LRCLIB timed out" : e.message}`);
        return { status: "none", why: "LRCLIB unreachable", lines: [], track: t, key };
      }).finally(() => inflight.delete(key)));
    }
    return (current = { ...(await inflight.get(key)), cached: false });
  }

  return { get, keyOf: np => keyOf(trackOf(np)), trackOf, peek: () => current };
}
