#!/usr/bin/env node
// Films the README's stills from the demo hub in headless Chromium: every painting at rest at 2x (3840 x 2160, for the
// close-ups and the card shots), the box of every card, and the dock rising on the Thunderhead painting at 1920 x 1080,
// stepped through with the page's own ?measure hooks. crop.py turns these into the README's files.
//   node tools/readme-media/film-stills.mjs --out <dir>
import fs from "node:fs";
import path from "node:path";
import { startHub, openTv, filmChange, chromium, NOW } from "./lib.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg("--out", "readme-frames/stills")), PORT = +arg("--port", 8796);
fs.mkdirSync(OUT, { recursive: true });
const CARDS = { calendar: "#widgets > :nth-child(1)", next: "#evCard", buses: "#widgets .bus", batteries: "#devRings",
  limits: "#cw", heatmap: "#cwh", today: "#ud", music: "#np" };
const boxes = page => page.evaluate(C => Object.fromEntries(Object.entries(C).map(([k, s]) => {
  const e = document.querySelector(s), r = e && e.getBoundingClientRect();
  return [k, r && r.width ? [r.x, r.y, r.width, r.height, parseFloat(getComputedStyle(e).borderTopLeftRadius)].map(v => Math.round(v * 10) / 10) : null];
})), CARDS);
const hub = await startHub(PORT);
const meta = { rest: {}, dock: [] };

// 1. each painting at rest, 2x
{
  const { browser, page } = await openTv(PORT, { scale: 2 });
  for (let k = 0; k < 4; k++) await filmChange(page, [], () => {});        // a lap first, as in film-loop.mjs
  for (let k = 0; k < 4; k++) {
    const st = await page.evaluate(() => ({ i: __state().i }));
    const id = ["f22-alaska", "f22-thunderhead", "placeholder", "placeholder-dawn"][st.i];
    await page.screenshot({ path: path.join(OUT, `rest-${id}.png`) });
    meta.rest[id] = await boxes(page);
    await filmChange(page, [], () => {});
  }
  await browser.close();
}
// 2. the dock rising over Thunderhead, 1x: the first arrow press raises it (dock "remote"); 25 frames a second
{
  const { browser, page } = await openTv(PORT, { start: "f22-thunderhead" });
  for (let k = 0; k < 4; k++) await filmChange(page, [], () => {});
  const shot = async (f, ms) => { await page.screenshot({ path: path.join(OUT, f) }); meta.dock.push({ f, ms }); };
  await shot("dock-000.png", 1200);
  await page.evaluate(() => window.__seekMode(true));
  await page.keyboard.press("ArrowRight");
  for (let t = 40, n = 1; t <= 480; t += 40, n++) { await page.evaluate(t => window.__seek(t), t); await shot(`dock-${String(n).padStart(3, "0")}.png`, 40); }
  await page.evaluate(() => { window.__seekMode(false); for (const a of document.getAnimations()) a.play(); });
  await page.waitForTimeout(800);
  await shot("dock-up.png", 2400);
  meta.dockBoxes = await page.evaluate(() => Object.fromEntries(["#dock", "#np", "#dock .dapp.focus .name"].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return [s, [r.x, r.y, r.width, r.height].map(Math.round)]; })));
  // and away again: Up while it shows slides it away (the page's own key), so the clip loops without a cut
  await page.evaluate(() => window.__seekMode(true));
  await page.keyboard.press("ArrowUp");
  for (let t = 40, n = 1; t <= 480; t += 40, n++) { await page.evaluate(t => window.__seek(t), t); await shot(`dock-down-${String(n).padStart(3, "0")}.png`, 40); }
  await page.evaluate(() => { window.__seekMode(false); for (const a of document.getAnimations()) a.play(); });
  await browser.close();
}
// 3. the setup page (no ?kiosk), once its strip and preview have settled
{
  const browser = await chromium.launch({ proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" } : undefined });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, timezoneId: "Asia/Singapore" });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(NOW));
  await page.goto(`http://127.0.0.1:${PORT}/tv-setup.html?start=f22-thunderhead`, { waitUntil: "load" });
  await page.waitForFunction(() => document.fonts.status === "loaded", null, { timeout: 60e3 });
  await page.waitForTimeout(6000);
  await page.mouse.move(5, 5);                        // no hover state anywhere
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, "setup.png") });
  await browser.close();
}
fs.writeFileSync(path.join(OUT, "stills.json"), JSON.stringify(meta, null, 1));
console.log("stills in", OUT); hub.kill();
