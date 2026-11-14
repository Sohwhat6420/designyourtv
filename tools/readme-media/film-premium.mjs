#!/usr/bin/env node
// Films the README's lead pictures from the demo hub in headless Chromium, the way the author had his own TV set up:
// his Concorde painting with its saved clock settings, a three-stop bus card, the dock with the apps' real icons, the
// rain layer, the always-on display and the night veil. The page is the repository's own tv-setup.html; only what the
// repository does not ship is handed in from a private folder:
//   <private>/plates/plane-concorde-climb.{plate,fg,fgall,subj}.webp   the painting and its cut-outs
//   <private>/icons/tv/<app id>.webp                                    the apps' icons (their owners' artwork)
//   <private>/activity.json                                             optional: { replies, tokens, total } per day
// Bus stops and service numbers are made up. Nothing is written anywhere but --out; every request but GET is refused.
//   node tools/readme-media/film-premium.mjs --private <dir> --out <dir> [--port 8797] [--only hero,loop,dock,aod,night,setup]
//        [--start <plate id>]   another painting to film (one of the repository's own, for instance)
import fs from "node:fs";
import path from "node:path";
import { startHub, chromium, NOW, HERE } from "./lib.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg("--out", "readme-frames/premium")), PORT = +arg("--port", 8797);
const PRIV = path.resolve(arg("--private", "private"));
const ONLY = (arg("--only", "hero,loop,dock,aod,night,setup")).split(",");
const START = arg("--start", "plane-concorde-climb");
fs.mkdirSync(OUT, { recursive: true });

const PLATE = `{id:"plane-concorde-climb", name:"Concorde climbing out, rain", mine:false, ink:"#cfdaf5", mode:"light", face:"tall", sugg:{size:22}},`;
const iso = ms => new Date(ms).toISOString(), T0 = Date.parse(NOW);
const arr = (min, load = "SEA") => ({ min, eta: iso(T0 + min * 60e3), load, type: "DD", monitored: true, feature: "WAB" });
const svc = (no, a, b, load) => ({ no, operator: "SBST", next: [arr(a, load), arr(b)] });
// three stops and six services: the shape of the author's own card, with made-up names and numbers
const BUS = { read_at: iso(T0), excluded: [], stops: [
  { code: "10001", name: "Harbour Rd", services: [svc("12", 7, 13)] },
  { code: "10002", name: "Park Ave", services: [svc("31", 0, 15), svc("45", 4, 16), svc("7", 9, 21, "SDA")] },
  { code: "10003", name: "Market St", services: [svc("22", 6, 7, "SDA"), svc("63", 2, 11)] },
] };
const WEATHER = { area: "City", forecast: "Showers", valid_text: "10 am to 12 pm", read_at: iso(T0), stale: false };
let ACTIVITY = null;
try {
  const a = JSON.parse(fs.readFileSync(path.join(PRIV, "activity.json"), "utf8"));
  ACTIVITY = { made: iso(T0), tz: "Asia/Singapore", replies: a.replies || {}, prompts: {}, tokens: a.tokens || {}, total: a.total ?? null, devices: [] };
} catch { /* none: the page shows its own labelled sample */ }
const MIME = { ".webp": "image/webp", ".png": "image/png" };
const file = (r, p) => fs.existsSync(p) ? r.fulfill({ status: 200, contentType: MIME[path.extname(p)] || "application/octet-stream", body: fs.readFileSync(p) }) : r.fulfill({ status: 404, body: "" });

async function open({ query = "", scale = 1, kiosk = true, start = START } = {}) {
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" } : undefined;
  const browser = await chromium.launch({ proxy, executablePath: process.env.TV_CHROMIUM || undefined });   // TV_CHROMIUM: a headless shell to use instead of Playwright's default
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: scale, timezoneId: "Asia/Singapore", reducedMotion: "no-preference" });
  await ctx.route("**/*", async r => {
    const req = r.request(), u = new URL(req.url());
    if (!["GET", "HEAD"].includes(req.method())) return r.abort();
    if (u.hostname !== "127.0.0.1") return r.continue();
    if (u.pathname === "/api/events") return r.abort();   // the hub's stream would push its own sample bus card over ours; the page polls instead
    if (u.pathname === "/api/bus") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(BUS) });
    if (u.pathname === "/api/weather") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WEATHER) });
    if (u.pathname === "/api/activity" && ACTIVITY) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ACTIVITY) });
    if (u.pathname.startsWith("/plates/plane-concorde-climb.")) return file(r, path.join(PRIV, "plates", path.basename(u.pathname)));
    if (u.pathname.startsWith("/icons/tv/")) return file(r, path.join(PRIV, "icons", "tv", path.basename(u.pathname)));
    if (u.pathname === "/tv-setup.html") {
      const res = await r.fetch(); let body = await res.text();
      if (!body.includes("const PLATES = [")) throw new Error("PLATES not found in the page");
      if (!body.includes('id:"plane-concorde-climb"')) body = body.replace("const PLATES = [", "const PLATES = [\n  " + PLATE);
      return r.fulfill({ response: res, body });
    }
    return r.continue();
  });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(NOW));
  page.on("pageerror", e => console.error("page error:", e.message));
  await page.goto(`http://127.0.0.1:${PORT}/tv-setup.html?${kiosk ? "kiosk=tv&" : ""}measure&start=${start}${query}`, { waitUntil: "load" });
  await page.waitForFunction(() => document.fonts.status === "loaded", null, { timeout: 60e3 });
  if (kiosk) {
    await page.waitForFunction(() => window.__ready && window.__ready(), null, { timeout: 60e3 });
    await page.waitForFunction(() => !document.querySelector("#stage .wpend"), null, { timeout: 45e3, polling: 500 });
  }
  await page.waitForTimeout(2500);
  return { browser, page };
}
const CARDS = { calendar: "#widgets > :nth-child(1)", next: "#evCard", buses: "#widgets .bus", batteries: "#devRings",
  limits: "#cw", heatmap: "#cwh", today: "#ud", music: "#np", dock: "#dock", clock: "#decks" };
const boxes = page => page.evaluate(C => Object.fromEntries(Object.entries(C).map(([k, s]) => {
  const e = document.querySelector(s), r = e && e.getBoundingClientRect();
  return [k, r && r.width ? [r.x, r.y, r.width, r.height].map(v => Math.round(v * 10) / 10) : null];
})), CARDS);
const meta = {};
const hub = await startHub(PORT, path.join(HERE, "config.premium.json"));
try {
  if (ONLY.includes("hero")) {                         // at rest, 2x: the hero still, the depth close-up and the card crops
    const { browser, page } = await open({ scale: 2 });
    await page.screenshot({ path: path.join(OUT, "rest@2x.png") });
    meta.rest = await boxes(page);
    meta.text = await page.evaluate(() => document.querySelector("#stage").innerText);
    meta.plate = await page.evaluate(() => PLATES[__state().i].id);
    await browser.close();
  }
  // One continuous take on a virtual clock: every running animation and transition (the rain's keyframes, the dock's
  // slide, the veil) is held and stepped 80 ms a frame, so the clip is 12.5 frames a second whatever a screenshot costs.
  const STEP = 80;
  const take = async (page, tag, list) => {
    const shot = async ms => { const f = `${tag}-${String(list.length).padStart(3, "0")}.jpg`; await page.screenshot({ path: path.join(OUT, f), type: "jpeg", quality: 93 }); list.push({ f, ms }); };
    const tick = () => page.evaluate(dt => { for (const a of document.getAnimations()) { try { if (a.playState !== "paused") a.pause(); a.currentTime = (+a.currentTime || 0) + dt; } catch {} } }, STEP);
    return { frames: async n => { for (let k = 0; k < n; k++) { await tick(); await shot(STEP); } }, hold: ms => shot(ms),
      key: async k => { await page.keyboard.press(k); await page.waitForTimeout(60); } };
  };
  if (ONLY.includes("loop")) {                         // rain falling; the dock rises, the focus walks four apps, the dock leaves
    const { browser, page } = await open();
    meta.loop = []; const t = await take(page, "loop", meta.loop);
    await t.frames(18);
    await t.key("ArrowRight"); await t.frames(16);
    for (const n of [9, 9, 12]) { await t.key("ArrowRight"); await t.frames(n); }
    meta.dockBoxes = await boxes(page);
    meta.dockFocus = await page.evaluate(() => (document.querySelector("#dock .dapp.focus .name") || {}).textContent || "");
    await t.key("ArrowUp"); await t.frames(14);
    await browser.close();
  }
  if (ONLY.includes("dock")) {                         // the dock up at 2x, for a still
    const { browser, page } = await open({ scale: 2 });
    await page.keyboard.press("ArrowRight"); await page.waitForTimeout(1500);
    for (let k = 0; k < 3; k++) { await page.keyboard.press("ArrowRight"); await page.waitForTimeout(500); }
    await page.screenshot({ path: path.join(OUT, "dock@2x.png") });
    meta.dock2x = await boxes(page);
    await browser.close();
  }
  if (ONLY.includes("aod")) {                          // the always-on display: the screen at rest, the veil coming down, steady, a key wakes it
    const { browser, page } = await open();
    meta.aodClip = []; const t = await take(page, "aod", meta.aodClip);
    await t.frames(12);
    await page.evaluate(() => setAmb(true)); await page.waitForTimeout(60);
    await t.frames(30);
    await page.waitForTimeout(3500);
    await page.screenshot({ path: path.join(OUT, "aod-steady.png") });
    meta.aod = await page.evaluate(() => ({ cls: document.querySelector("#stage").className, anims: document.getAnimations().filter(a => !(a instanceof CSSTransition) && a.playState === "running").length,
      time: document.querySelector("#ambTime").textContent, date: document.querySelector("#ambDate").textContent,
      depth: !document.querySelector("#stage").classList.contains("amb-flat"), cover: typeof amb === "object" && amb.cover != null ? Math.round(amb.cover * 100) / 100 : null }));
    await t.hold(2400);
    await t.key("ArrowDown"); await t.frames(16);
    await browser.close();
  }
  if (ONLY.includes("night")) {                        // night on OK: one veil, the widgets still readable
    const { browser, page } = await open();
    await page.evaluate(() => setDim(true));
    await page.waitForTimeout(4000); await page.screenshot({ path: path.join(OUT, "night.png") });
    meta.night = await page.evaluate(() => ({ cls: document.querySelector("#stage").className, anims: document.getAnimations().filter(a => !(a instanceof CSSTransition) && a.playState === "running").length }));
    await browser.close();
  }
  if (ONLY.includes("setup")) {                        // the setup page on the same painting
    const { browser, page } = await open({ kiosk: false });
    await page.waitForTimeout(5000); await page.mouse.move(5, 5); await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, "setup.png") });
    await browser.close();
  }
} finally {
  const f = path.join(OUT, "premium.json");
  let old = {}; try { old = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  fs.writeFileSync(f, JSON.stringify({ ...old, ...meta }, null, 1));
  hub.kill();
}
console.log("frames in", OUT);
