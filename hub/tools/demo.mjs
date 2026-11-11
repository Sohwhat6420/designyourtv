#!/usr/bin/env node
// A demo hub: the real server with sample data in place of every reader, so the page can be tried in a browser with no TV,
// no phones, no adb, no keys and no network. It reads nothing from this machine and writes only to a throwaway folder.
//   node hub/tools/demo.mjs [--port 8790]
//   then open http://127.0.0.1:8790/tv-setup.html?kiosk=tv  (the TV)  or  http://127.0.0.1:8790/tv-setup.html  (setup)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHub } from "../server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "designyourtv-demo-"));
fs.copyFileSync(path.join(ROOT, "examples", "config.example.json"), path.join(stateDir, "config.json"));

const iso = ms => new Date(ms).toISOString();
const inMin = m => iso(Date.now() + m * 60e3);
const services = [
  { no: "21", operator: "SBST", next: [3, 14, 26] },
  { no: "52", operator: "SBST", next: [7, 19, 33] },
  { no: "88", operator: "SMRT", next: [1, 11, 24] },
].map(s => ({ ...s, next: s.next.map(m => ({ min: m, eta: inMin(m), load: m < 5 ? "SDA" : "SEA", type: "DD", monitored: true, feature: "WAB" })) }));
const track = { status: "playing", title: "Placeholder Song", artist: "The Demo Band", album: "Sample Sessions", duration_s: 214, position_s: 61, app: "demo", read_at: iso(Date.now()) };
const nextEvent = () => {
  const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
  const card = { title: "Dentist", short: "Dentist", start: iso(+d), end: iso(+d + 45 * 60e3), all_day: false, location: null, in_min: Math.round((+d - Date.now()) / 60e3), started: false };
  return { status: "ok", next: card, now: [], upcoming: [card], read_at: iso(Date.now()) };
};

const hub = await createHub({
  root: ROOT, stateDir, port: Number(arg("--port", 8790)), host: "127.0.0.1", device: "demo", activityJob: false,
  log: () => {},
  monitor: {
    snapshot: () => ({ device: "demo", hostname: "demo", platform: process.platform, read_at: iso(Date.now()), uptime_s: 86400, cpu_pct: 9, cores: 8 }),
    nowPlaying: () => ({ ...track, read_at: iso(Date.now()) }),
    on() {}, stop() {},
  },
  claude: async () => ({ session: { pct: 23, reset: "3h 10m" }, weekly: { pct: 41, reset: "Fri 10:00" }, read_at: iso(Date.now()), stale: false, source: "demo" }),
  bus: { get: async () => ({ read_at: iso(Date.now()), stops: [{ code: "10001", name: "Riverside Stop", services }], excluded: [] }), peek: () => null },
  phones: {
    list: () => [
      { id: "phone", name: "Phone", pct: 78, charging: false, online: true, read_at: iso(Date.now()) },
      { id: "tablet", name: "Tablet", pct: 22, charging: true, online: true, read_at: iso(Date.now()) },
    ],
    wearables: () => ({ status: "ok", phone: "phone", phone_online: true, read_at: iso(Date.now()), watch: { name: "Watch", pct: 64 }, buds: { name: "Buds", pct: 90 }, devices: [] }),
    stop() {},
  },
  poco: null,
  tv: null,
  media: { press: async () => ({ ok: false, why: "demo" }) },
  waiting: { get: () => ({ read_at: iso(Date.now()), count: 0, older: 0, items: [] }) },
  weather: { get: async area => ({ area: area || "Demo", forecast: "Partly Cloudy (Night)", valid_text: "8 to 10 pm", read_at: iso(Date.now()), stale: false }) },
  lyrics: { get: async () => ({ status: "none", why: "demo", lines: [], track: null, key: null }), keyOf: () => null, peek: () => null },
  next: { get: async () => nextEvent(), peek: () => nextEvent() },
});
console.log(`designyourtv demo on ${hub.url}/tv-setup.html?kiosk=tv  (setup: ${hub.url}/tv-setup.html)`);
const bye = () => hub.close().finally(() => { fs.rmSync(stateDir, { recursive: true, force: true }); process.exit(0); });
process.on("SIGINT", bye); process.on("SIGTERM", bye);
