// Shared by the README capture scripts: a demo hub on a fixed clock, and the real TV page in headless Chromium.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");
export const NOW = "2026-11-11T10:47:00+08:00";      // Wednesday 11 November, 10:47 in Singapore: every shot shows this moment
export const { chromium } = createRequire(import.meta.url)("playwright");

/** the demo hub (hub/tools/demo.mjs) with the capture config, its clock starting at NOW; resolves once it listens */
export function startHub(port, config = path.join(HERE, "config.capture.json"), { realClock = false } = {}) {
  const p = spawn(process.execPath, ["--import", "./" + path.relative(ROOT, path.join(HERE, "fake-now.mjs")).split(path.sep).join("/"),
    "hub/tools/demo.mjs", "--port", String(port), "--config", config],
    { cwd: ROOT, env: { ...process.env, FAKE_NOW: realClock ? "" : NOW, TZ: "Asia/Singapore" }, stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  return new Promise((res, rej) => {
    p.stdout.on("data", d => { if (/demo on/.test(String(d))) res(p); });
    p.on("exit", c => rej(new Error("demo hub exited " + c)));
  });
}

/** headless Chromium (Playwright's own), the page's clock pinned to NOW. Off-machine requests (Google Fonts) use the proxy if one is set */
export async function openTv(port, { query = "", scale = 1, width = 1920, height = 1080, start = "f22-alaska", fixed = true, init = null } = {}) {
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" } : undefined;
  const browser = await chromium.launch({ proxy });
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, timezoneId: "Asia/Singapore", reducedMotion: "no-preference" });
  const page = await ctx.newPage();
  if (fixed) await page.clock.setFixedTime(new Date(NOW));     // fixed: false keeps the real clock (for measuring)
  if (init) await page.addInitScript(init);
  const responses = []; page.on("response", r => responses.push(r)); page.responses = responses;
  page.on("pageerror", e => console.error("page error:", e.message));
  await page.goto(`http://127.0.0.1:${port}/tv-setup.html?kiosk=tv&measure&start=${start}${query}`, { waitUntil: "load" });
  await page.waitForFunction(() => document.fonts.status === "loaded" && window.__ready && window.__ready(), null, { timeout: 60e3 });
  // a TV card waits for its first reading (.wpend) and shows anyway after 30 s; the demo has no Claude Code activity job, so
  // its heatmap shows the page's own labelled sample ("· sample"). Waiting for that keeps every frame's set of cards the same
  await page.waitForFunction(() => !document.querySelector("#stage .wpend"), null, { timeout: 45e3, polling: 500 });
  await page.waitForTimeout(1500);                    // the start-up cover's fade, and the last card's
  return { browser, page };
}

/** run one painting change (the page's own, ?measure hooks) and call shot(t) at each time in ms; then let it settle */
export async function filmChange(page, times, shot, dir = 1) {
  await page.waitForFunction(() => window.__ready(), null, { timeout: 60e3 });
  const to = await page.evaluate(d => new Promise(res => {
    window.__seekMode(true);
    window.__onRun = () => res(window.__state().i);   // the change is planned (on the TV, a frame after the press)
    window.__swapAt(d);
  }), dir);
  for (const t of times) { await page.evaluate(t => window.__seek(t), t); await shot(t); }
  await page.evaluate(() => { window.__settled = null; window.__seekMode(false); for (const a of document.getAnimations()) a.play(); });
  await page.waitForFunction(to => window.__settled && window.__settled.to === to, to, { timeout: 30e3 });
  return to;
}
