// The home hub: runs on one always-on machine (the "desk" laptop) and serves every screen in the house (the TV, the desk
// laptop, the travel laptop) from one configuration, with live Claude limits, buses, system stats, phone batteries and
// what is playing.
//   node hub/server.mjs            listens on 0.0.0.0:8790 (TV_HUB_PORT), LAN and loopback only
// Zero dependencies: node built-ins only. See hub/README.md for the API and what runs where.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAllowedAddress, isAllowedOrigin, isLoopback } from "./lib/net-guard.mjs";
import { sendJson, readJson, resolveSafe, serveFile, HttpError, isPlainObject, makeLogger, etagOf, writeAtomic } from "./lib/http-util.mjs";
import { createSse } from "./lib/sse.mjs";
import { createConfigStore, ID_RE } from "./lib/config-store.mjs";
import { createBusReader, readKey } from "./lib/bus.mjs";
import { createPocoBattery, createNtfyPush, reminderPhone } from "./poco-battery.mjs";
import { createSystemMonitor } from "./lib/system-stats.mjs";
import { createPhoneMonitor } from "./lib/phones.mjs";
import { createMediaControl } from "./lib/media-control.mjs";
import { createWaitingReader } from "./lib/waiting.mjs";
import { createWeatherReader } from "./lib/weather.mjs";
import { createLyricsReader } from "./lib/lyrics.mjs";
import { createNextReader } from "./lib/next.mjs";
import { createTvKeeper } from "./lib/tv-power.mjs";

export const VERSION = "1.0.0";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
const MIN = 60e3;

/** Folders and files the hub never serves (sources, masters, research, its own state). Lower-case, forward slashes. */
export const DENY = ["refs", "masters", "models", "mockup", "research", "tools", "apk", "devices", "hub/state", "hub/test", "hub/cache"];
// plates-4k: only the webp the laptops show; its pipeline PNGs stay home
export const denyPath = rel => DENY.some(d => rel === d || rel.startsWith(d + "/")) || /(^|\/)[^/]*\.(py|key|log|pyc)$/.test(rel)
  || (rel.startsWith("plates-4k/") && !rel.endsWith(".webp"));

/** What a device agent mirrors: the pages, the plates, icons, data, fonts and the status page. */
export const MIRROR = [
  { dir: "", match: f => /\.html$/i.test(f), deep: false },
  { dir: "plates", match: f => /\.webp$/i.test(f), deep: true },
  { dir: "plates-4k", match: f => /\.webp$/i.test(f), deep: true },
  { dir: "icons", match: () => true, deep: true },
  { dir: "data", match: f => /\.json$/i.test(f), deep: true },
  { dir: "fonts", match: () => true, deep: true },
  { dir: "hub/ui", match: () => true, deep: true },
];

/**
 * The Host header must be an address, localhost, this machine's name or a home-network name. A public web page that
 * re-points its own domain at a LAN address (DNS rebinding) arrives with its domain as the Host, and is refused.
 */
export function isAllowedHost(hostHeader, hostname = os.hostname()) {
  if (!hostHeader) return true;                                   // HTTP/1.0 clients; the address check still applies
  let h;
  try { h = new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, "").toLowerCase(); } catch { return false; }
  if (net.isIP(h)) return isAllowedAddress(h);
  return h === "localhost" || h.endsWith(".localhost") || h === hostname.toLowerCase() || /\.(local|lan|home\.arpa|home|internal)$/.test(h);
}

const lanIps = () => Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === "IPv4" && !i.internal).map(i => i.address);

/** The next 04:00 in Singapore (UTC+8, no daylight saving) after `now`. */
export function next4amSgt(now = Date.now()) {
  const sg = new Date(now + 8 * 3600e3);
  let t = Date.UTC(sg.getUTCFullYear(), sg.getUTCMonth(), sg.getUTCDate(), 4) - 8 * 3600e3;
  if (t <= now) t += 24 * 3600e3;
  return t;
}

/**
 * Build the hub. Everything that touches the machine or the network is injectable, so the tests start a hub with no
 * child processes and no internet: {port, host, root, stateDir, monitor, claude, bus, phones, poco, lyrics, next, activityJob, log}.
 * A hub given its own `phones` (every test hub) gets no POCO reminder reader unless it passes `poco` too.
 */
export async function createHub(opts = {}) {
  const root = opts.root || ROOT;
  const stateDir = opts.stateDir || path.join(root, "hub", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const log = opts.log || makeLogger(path.join(stateDir, "hub.log"), { redact: [() => readKey()] });
  const deviceName = opts.device || process.env.TV_HUB_DEVICE || "desk";
  const started = Date.now();
  const sse = createSse({ pingMs: opts.pingMs || 15e3 });

  const config = createConfigStore(stateDir, { onChange: e => sse.send("config", e) });
  const monitor = opts.monitor !== undefined ? opts.monitor : createSystemMonitor({ device: deviceName, log });
  const bus = opts.bus || createBusReader({ log });
  const claudeFn = opts.claude || (await import("./lib/claude-worker.mjs")).createClaudeReader().get;
  const phones = opts.phones !== undefined ? opts.phones
    : createPhoneMonitor({ log, onChange: list => sse.send("batteries", list), onWearables: w => sse.send("wearables", w) }).start();
  // Battery reminders for the phone marked "reminder" in hub/state/phones.json (hub/poco-battery.mjs): <= 25 % and not
  // charging, >= 90 % and charging, once per crossing, sent as an SSE "reminder" the pages show as a toast. The phone
  // monitor above already does the `adb connect`, so this one only reads. Its ntfy push stays off unless TV_POCO_PUSH=1.
  const poco = opts.poco !== undefined ? opts.poco : opts.phones !== undefined || !reminderPhone() ? null
    : createPocoBattery({ log, connect: false, stateFile: path.join(stateDir, "poco-battery.json"),
      onReminder: r => sse.send("reminder", r), push: createNtfyPush({ enabled: process.env.TV_POCO_PUSH === "1" }) }).start();

  const media = opts.media || createMediaControl();
  const waiting = opts.waiting || createWaitingReader();
  const weather = opts.weather || createWeatherReader({ log });
  // Lyrics for the current track (LRCLIB; only the title, artist, album and length leave the machine; cached in hub/cache/)
  // and the next calendar event (an ICS address the owner puts in hub/state/calendar.json; "unconfigured" until then).
  const lyrics = opts.lyrics || createLyricsReader({ log, cacheDir: opts.cacheDir || path.join(root, "hub", "cache", "lyrics") });
  const next = opts.next || createNextReader({ log, configFile: path.join(stateDir, "calendar.json") });
  // The TV kept on adb (a check every 20 s, reconnect with backoff) and switched on/off (hub/lib/tv-power.mjs). Like
  // the phone battery reader, a hub given its own `phones` (every test hub) gets no keeper unless it passes `tv` too.
  // "Off" from outside leaves the TV awake and dark; the picture comes back with `on`.
  const tv = opts.tv !== undefined ? opts.tv : opts.phones !== undefined ? null
    : createTvKeeper({ log, a11yHeal: true, stateFile: path.join(stateDir, "tv.json"), onChange: s => sse.send("tv", s) }).start();

  // ---------- readings with caches ----------
  let claude = { at: 0, data: null, inflight: null };
  async function getClaude() {
    if (claude.data && Date.now() - claude.at < MIN) return claude.data;
    claude.inflight ??= Promise.resolve(claudeFn({ allowProbe: true })).then(d => {
      claude = { at: Date.now(), data: d || { available: false, why: "no reading yet" }, inflight: null };
      return claude.data;
    }).catch(e => { log("error", `claude: ${e.message}`); claude.inflight = null; return claude.data || { available: false, why: "reader failed" }; });
    return claude.inflight;
  }

  const pushed = new Map();   // device -> {data, received_at, ip}
  const clients = new Map();  // ip -> {ip, last_seen, ua, last_path, device}
  let manifest = { at: 0, data: null };

  function buildManifest() {
    if (manifest.data && Date.now() - manifest.at < 10e3) return manifest.data;
    const files = [];
    for (const m of MIRROR) {
      const base = path.join(root, m.dir);
      (function walk(dir, rel) {
        let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (e.name.startsWith(".")) continue;
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) { if (m.deep) walk(path.join(dir, e.name), r); continue; }
          if (!e.isFile() || !m.match(e.name)) continue;
          const full = m.dir ? `${m.dir}/${r}` : r;
          if (denyPath(full.toLowerCase())) continue;
          const st = fs.statSync(path.join(dir, e.name));
          files.push({ path: full, size: st.size, mtime: new Date(st.mtimeMs).toISOString(), etag: etagOf(st) });
        }
      })(base, "");
    }
    manifest = { at: Date.now(), data: { made: new Date().toISOString(), files } };
    return manifest.data;
  }

  // ---------- the daily activity job ----------
  const job = { running: false, last_start: null, last_exit: null, last_code: null, next: null, pid: null };
  const activityFile = path.join(root, "data", "claude-activity.json");
  function runActivityJob() {
    if (job.running) return;
    const script = path.join(HERE, "jobs", "claude-activity.mjs");
    const projects = path.join(os.homedir(), ".claude", "projects");
    const env = { ...process.env }; delete env.CLAUDE_PROGRESS_SH;
    const child = spawn(process.execPath, [script, projects, activityFile], { windowsHide: true, stdio: "ignore", env });
    job.running = true; job.last_start = new Date().toISOString(); job.pid = child.pid;
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* fine at normal */ }
    child.on("error", e => { job.running = false; log("error", `activity job: ${e.message}`); });
    child.on("exit", code => {
      job.running = false; job.pid = null; job.last_exit = new Date().toISOString(); job.last_code = code;
      if (code !== 0) log("error", `activity job exited ${code}`);
      else sse.send("activity", { made: job.last_exit });
    });
  }
  /* Each laptop's agent counts its own transcripts and sends them here (POST /api/activity/<device>); GET adds every
     machine's days and tokens together, so the heatmap and the token total on all three screens cover both laptops. */
  const devActivity = dev => path.join(root, "data", `claude-activity.${dev}.json`);
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const cleanDays = o => {
    const out = {}; if (!isPlainObject(o)) return out;
    for (const [k, v] of Object.entries(o).slice(-800)) if (DAY_RE.test(k) && Number.isSafeInteger(v) && v >= 0) out[k] = v;
    return out;
  };
  function readActivity() {
    const parts = [];
    try { parts.push({ device: deviceName, ...JSON.parse(fs.readFileSync(activityFile, "utf8")) }); } catch { /* not made yet */ }
    let names = []; try { names = fs.readdirSync(path.dirname(activityFile)); } catch { /* no data folder */ }
    for (const n of names) {
      const m = /^claude-activity\.([A-Za-z0-9._-]{1,64})\.json$/.exec(n); if (!m || m[1] === deviceName) continue;
      try { parts.push({ ...JSON.parse(fs.readFileSync(path.join(path.dirname(activityFile), n), "utf8")), device: m[1] }); } catch { /* half-written */ }
    }
    if (!parts.length) return null;
    const add = (into, o) => { for (const [k, v] of Object.entries(cleanDays(o))) into[k] = (into[k] || 0) + v; return into; };
    const replies = {}, prompts = {}, tokens = {};
    for (const p of parts) { add(replies, p.replies); add(prompts, p.prompts); add(tokens, p.tokens); }
    const devices = parts.map(p => ({ device: p.device, made: p.made || null, total: Number.isSafeInteger(p.total) ? p.total : null }));
    return { made: parts.map(p => p.made || "").sort().pop() || null, tz: "Asia/Singapore", replies, prompts, tokens,
      total: devices.every(d => d.total === null) ? null : devices.reduce((s, d) => s + (d.total || 0), 0), devices };
  }
  let jobTimer = null;
  function scheduleJob() {
    const at = next4amSgt();
    job.next = new Date(at).toISOString();
    jobTimer = setTimeout(() => { runActivityJob(); scheduleJob(); }, at - Date.now());
    jobTimer.unref();
  }
  if (opts.activityJob !== false) {
    scheduleJob();
    // A file older than 26 h means a 04:00 run was missed (the desk laptop was off): catch up ten minutes after start.
    try { if (Date.now() - fs.statSync(activityFile).mtimeMs > 26 * 3600e3) setTimeout(runActivityJob, 10 * MIN).unref(); }
    catch { setTimeout(runActivityJob, 10 * MIN).unref(); }
  }

  // ---------- event stream timers (work only while someone is listening) ----------
  const timers = [];
  const every = (ms, fn) => { const t = setInterval(() => { if (sse.size) fn(); }, ms); t.unref(); timers.push(t); };
  const sysSnap = () => monitor.snapshot();
  if (monitor) {
    every(opts.systemMs || 2000, () => sse.send("system", sysSnap()));
    // a "lyrics" event whenever the TRACK changes (not on play/pause): the new words, or {status:"none"}
    let lyricsKey;
    const onTrack = np => {
      const k = lyrics.keyOf(np);
      if (k === lyricsKey) return;
      lyricsKey = k;
      lyrics.get(np).then(d => { if (lyricsKey === k) sse.send("lyrics", d); }).catch(e => log("warn", `lyrics: ${e.message}`));
    };
    monitor.on?.("nowplaying", np => { sse.send("nowplaying", np); onTrack(np); });
  }
  every(60e3, () => getClaude().then(d => sse.send("claude", d)));
  every(30e3, () => bus.get().then(d => sse.send("bus", d)).catch(() => {}));
  every(60e3, () => sse.send("waiting", waiting.get()));
  every(5 * MIN, () => phones && sse.send("batteries", phones.list()));
  every(5 * MIN, () => phones?.wearables && sse.send("wearables", phones.wearables()));
  every(5 * MIN, () => next.get().then(d => d.status === "ok" && sse.send("next", d)).catch(() => {}));

  // ---------- routing ----------
  const nowPlaying = () => (monitor ? monitor.nowPlaying() : { status: "unavailable", why: "no monitor" });

  async function api(req, res, url) {
    const p = url.pathname, m = req.method;
    const isGet = m === "GET" || m === "HEAD";
    if (p === "/api/health" && isGet) {
      return sendJson(res, 200, { ok: true, version: VERSION, uptime_s: Math.round((Date.now() - started) / 1000),
        hostname: os.hostname(), device: deviceName, lan_ips: lanIps(), sse_clients: sse.size, activity_job: job });
    }
    if (p === "/api/claude" && isGet) return sendJson(res, 200, await getClaude());
    if (p === "/api/waiting" && isGet) return sendJson(res, 200, waiting.get());
    if (p === "/api/weather" && isGet) {
      const area = (url.searchParams.get("area") || process.env.TV_WEATHER_AREA || "City").slice(0, 40);
      if (!/^[A-Za-z .'-]+$/.test(area)) throw new HttpError(400, "bad area");
      return sendJson(res, 200, await weather.get(area));
    }
    if (p === "/api/system" && isGet) return sendJson(res, 200, monitor ? sysSnap() : { available: false });
    const sys = /^\/api\/system\/([^/]+)$/.exec(p);
    if (sys) {
      const dev = decodeURIComponent(sys[1]);
      if (!ID_RE.test(dev)) throw new HttpError(400, "bad device name");
      if (m === "POST") {
        const body = await readJson(req, 16 << 10);
        if (!isPlainObject(body)) throw new HttpError(400, "stats must be a JSON object");
        pushed.set(dev, { data: body, received_at: Date.now(), ip: req.socket.remoteAddress });
        sse.send("device", { device: dev, received_at: new Date().toISOString() });
        return sendJson(res, 200, { ok: true });
      }
      if (isGet) {
        if (dev === deviceName && monitor) return sendJson(res, 200, { ...sysSnap(), age_s: 0 });
        const v = pushed.get(dev);
        if (!v) throw new HttpError(404, "no stats from that device yet");
        return sendJson(res, 200, { ...v.data, device: dev, received_at: new Date(v.received_at).toISOString(), age_s: Math.round((Date.now() - v.received_at) / 1000) });
      }
    }
    if (p === "/api/devices" && isGet) {
      const now = Date.now();
      return sendJson(res, 200, {
        hub: { device: deviceName, hostname: os.hostname(), age_s: 0 },
        pushed: [...pushed].map(([device, v]) => ({ device, ip: v.ip, last_seen: new Date(v.received_at).toISOString(), age_s: Math.round((now - v.received_at) / 1000),
          cpu_pct: v.data.cpu_pct ?? null, battery: v.data.battery ?? null })),
        clients: [...clients.values()].sort((a, b) => b.last_seen - a.last_seen).slice(0, 20)
          .map(c => ({ ...c, last_seen: new Date(c.last_seen).toISOString(), age_s: Math.round((now - c.last_seen) / 1000) })),
        streams: [...sse.clients].map(c => c.info),
      });
    }
    if (p === "/api/bus" && isGet) return sendJson(res, 200, await bus.get());
    if (p === "/api/batteries" && isGet) return sendJson(res, 200, phones ? phones.list() : []);
    if (p === "/api/nowplaying" && isGet) return sendJson(res, 200, nowPlaying());
    // synced lyrics for the track playing now (no parameters: the hub never looks up anything the desk laptop is not playing)
    if (p === "/api/lyrics" && isGet) return sendJson(res, 200, await lyrics.get(nowPlaying()));
    // Galaxy Watch and Buds levels, read off the S24 by the phone monitor's own poll
    if (p === "/api/wearables" && isGet) return sendJson(res, 200, phones?.wearables ? phones.wearables() : { status: "unavailable", why: "no phone monitor" });
    // the next calendar event, from the owner's ICS address (hub/state/calendar.json)
    if (p === "/api/next" && isGet) return sendJson(res, 200, await next.get());
    // the Now Playing pill's buttons and the TV remote's media keys: one press on this laptop's media session
    const mc = /^\/api\/media\/([a-z]+)$/.exec(p);
    if (mc && m === "POST") {
      const r = await media.press(mc[1]);
      if (r.ok && monitor) setTimeout(() => sse.send("nowplaying", monitor.nowPlaying()), 1500);
      return sendJson(res, r.ok ? 200 : r.why === "unknown action" ? 400 : 409, r);
    }
    if (p === "/api/poco-battery" && isGet) return sendJson(res, 200, poco ? poco.snapshot() : { available: false });
    // the designyourtv: its adb keeper's state (?fresh=1 checks first), and on/off (hub/lib/tv-power.mjs)
    if (p === "/api/tv/status" && isGet) {
      if (!tv) throw new HttpError(503, "no TV keeper on this hub");
      return sendJson(res, 200, url.searchParams.get("fresh") === "1" ? await tv.refresh() : tv.snapshot());
    }
    if (p === "/api/tv/power" && m === "POST") {
      if (!tv) throw new HttpError(503, "no TV keeper on this hub");
      const b = await readJson(req, 4 << 10);
      if (!isPlainObject(b) || !["on", "off", "status"].includes(b.action)) throw new HttpError(400, 'send {"action":"on"|"off"|"status"}');
      const r = await tv.power(b.action, { cast: b.cast !== false, castOnly: b.cast_only === true, explicit: b.explicit === true, deep: b.deep === true });
      return sendJson(res, r.ok ? 200 : r.busy ? 409 : 502, r);
    }
    if (p === "/api/activity" && isGet) {
      const a = readActivity(); if (!a) throw new HttpError(404, "no activity file yet");
      return sendJson(res, 200, a, { "cache-control": "no-store" });
    }
    const act = /^\/api\/activity\/([^/]+)$/.exec(p);
    if (act && m === "POST") {
      let dev; try { dev = decodeURIComponent(act[1]); } catch { throw new HttpError(400, "bad device name"); }
      if (!ID_RE.test(dev) || dev === deviceName) throw new HttpError(400, "bad device name");
      const b = await readJson(req, 256 << 10);
      if (!isPlainObject(b)) throw new HttpError(400, "activity must be a JSON object");
      const total = Number.isSafeInteger(b.total) && b.total >= 0 ? b.total : null;
      writeAtomic(devActivity(dev), JSON.stringify({ made: typeof b.made === "string" ? b.made.slice(0, 40) : new Date().toISOString(), received_at: new Date().toISOString(),
        replies: cleanDays(b.replies), prompts: cleanDays(b.prompts), tokens: cleanDays(b.tokens), total }));
      sse.send("activity", { made: new Date().toISOString(), device: dev });
      return sendJson(res, 200, { ok: true });
    }
    if (p === "/api/manifest" && isGet) return sendJson(res, 200, buildManifest());
    if (p === "/api/config") {
      if (isGet) return sendJson(res, 200, config.get());
      if (m === "PUT") return sendJson(res, 200, config.put(await readJson(req, 256 << 10)));
    }
    const cp = /^\/api\/config\/(choices|globals)\/([^/]+)$/.exec(p);
    if (cp && m === "PATCH") {
      let id; try { id = decodeURIComponent(cp[2]); } catch { throw new HttpError(400, "bad id"); }
      return sendJson(res, 200, config.patch(cp[1], id, await readJson(req, 256 << 10)));
    }
    if (p === "/api/events" && isGet) {
      // ?skip=system: a screen that never draws the desk laptop's system readout (the TV) is not sent one every 2 s
      const skip = (url.searchParams.get("skip") || "").split(",").filter(x => x === "system");
      const info = { ip: req.socket.remoteAddress, device: (url.searchParams.get("device") || "").slice(0, 32) || null, ...(skip.length ? { skip } : {}) };
      const c = sse.attach(req, res, info, { headers: { "access-control-allow-origin": "*" } });
      const first = (ev, d) => { try { c.res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`); } catch { /* gone */ } };
      first("hello", { version: VERSION, device: deviceName, config_updatedAt: config.get().updatedAt });
      if (monitor) first("nowplaying", nowPlaying());
      if (phones) first("batteries", phones.list());
      if (phones?.wearables) first("wearables", phones.wearables());
      const ly = lyrics.peek?.(); if (ly && ly.key && ly.key === lyrics.keyOf(nowPlaying())) first("lyrics", ly);
      const nx = next.peek?.(); if (nx && nx.status === "ok") first("next", nx);
      if (tv) first("tv", tv.snapshot());
      if (claude.data) first("claude", claude.data);
      const b = bus.peek?.(); if (b) first("bus", b);
      return;
    }
    throw new HttpError(m === "GET" || m === "HEAD" || m === "POST" || m === "PUT" || m === "PATCH" ? 404 : 405, "no such endpoint");
  }

  async function handle(req, res) {
    const ip = req.socket.remoteAddress;
    if (!isAllowedAddress(ip)) { res.writeHead(403, { "content-type": "text/plain" }); return res.end("LAN only\n"); }
    if (!isAllowedHost(req.headers.host)) { res.writeHead(403, { "content-type": "text/plain" }); return res.end("unknown host name\n"); }
    let url;
    try { url = new URL(req.url, "http://hub.local"); } catch { return sendJson(res, 400, { error: "bad url" }); }
    const write = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    const origin = req.headers.origin;

    // CORS: any origin may read; only an origin in the house may write, and writes must be JSON (which forces a preflight).
    if (req.method === "OPTIONS") {
      const ok = isAllowedOrigin(origin);
      res.writeHead(204, { "access-control-allow-origin": ok ? origin || "*" : "*", "access-control-allow-methods": ok ? "GET, HEAD, POST, PUT, PATCH" : "GET, HEAD",
        "access-control-allow-headers": "content-type", "access-control-max-age": "600", vary: "origin" });
      return res.end();
    }
    if (write) {
      if (!isAllowedOrigin(origin)) return sendJson(res, 403, { error: "writes only from pages in the house" });
      if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) return sendJson(res, 415, { error: "send application/json" });
      if (origin) res.setHeader("access-control-allow-origin", origin), res.setHeader("vary", "origin");
    } else res.setHeader("access-control-allow-origin", "*");

    const c = clients.get(ip) || { ip };
    c.last_seen = Date.now(); c.ua = String(req.headers["user-agent"] || "").slice(0, 120); c.last_path = url.pathname.slice(0, 80);
    const k = url.searchParams.get("kiosk") || url.searchParams.get("device"); if (k) c.device = k.slice(0, 32);
    clients.set(ip, c);
    if (clients.size > 200) clients.delete(clients.keys().next().value);

    try {
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "read only");
      const raw = req.url.split("?")[0];
      if (raw === "/" || raw === "") {
        if (serveFile(req, res, path.join(HERE, "ui", "status.html"))) return;
        throw new HttpError(404, "no status page");
      }
      const f = resolveSafe(root, raw, denyPath);
      if (!f || f.missing || !serveFile(req, res, f.abs)) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found\n"); }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) log("error", `${req.method} ${url.pathname}: ${e.stack?.split("\n").slice(0, 2).join(" ") || e.message}`);
      if (!res.headersSent) sendJson(res, status, { error: status >= 500 ? "internal error" : e.message });
      else res.destroy();
    }
  }

  const server = http.createServer((req, res) => { handle(req, res).catch(() => { try { res.destroy(); } catch { /* gone */ } }); });
  server.keepAliveTimeout = 65e3;
  server.requestTimeout = 0;                    // event streams stay open
  server.headersTimeout = 30e3;
  const port = opts.port ?? Number(process.env.TV_HUB_PORT || 8790);
  const host = opts.host || "0.0.0.0";
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });

  return {
    server, sse, config, log, pushed,
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      timers.forEach(clearInterval); clearTimeout(jobTimer);
      sse.close(); monitor?.stop?.(); phones?.stop?.(); poco?.stop?.(); tv?.stop?.();
      await new Promise(r => { server.close(() => r()); server.closeAllConnections?.(); });
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hub = await createHub();
  hub.log("info", `hub ${VERSION} listening on 0.0.0.0:${hub.port} (pid ${process.pid})`);
  console.log(`tv-hub ${VERSION} on http://0.0.0.0:${hub.port}  lan ${lanIps().join(", ")}  pid ${process.pid}`);
  // the two first-run surprises on a real TV: a firewall that drops the TV's request, and an APK built for another address
  console.log(`build the TV's APK with one of: ${lanIps().map(ip => `--hub http://${ip}:${hub.port}`).join("  ") || "(no LAN address found)"}`);
  if (process.platform === "win32") console.log("if the TV shows the clock and date but no widgets, allow Node.js through Windows Firewall on Private networks");
  process.on("uncaughtException", e => hub.log("error", `uncaught: ${e.stack?.split("\n").slice(0, 3).join(" ")}`));
  process.on("unhandledRejection", e => hub.log("error", `unhandled: ${String(e?.stack || e).split("\n").slice(0, 3).join(" ")}`));
  const bye = () => hub.close().finally(() => process.exit(0));
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
}
