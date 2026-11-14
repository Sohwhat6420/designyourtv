#!/usr/bin/env node
// Films the README's loop: the TV page's own painting changes, through the whole rotation and back to the start, from
// the demo hub in headless Chromium at the TV panel's 1920 x 1080. Each change is stepped through with the page's own
// ?measure hooks (__swapAt, __seek), so every frame is exactly where the real 1.75 s change stands at that moment.
//   node tools/readme-media/film-loop.mjs --out <dir>      writes <dir>/f0000.png ... and <dir>/frames.json; encode.py makes the files
import fs from "node:fs";
import path from "node:path";
import { startHub, openTv, filmChange } from "./lib.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg("--out", "readme-frames/loop")), FPS = +arg("--fps", 25), HOLD = +arg("--hold", 2600), PORT = +arg("--port", 8794);
const CHANGE = 1800;                                   // the TV's change ends at 1750 ms (T.push); one more frame for the settle
fs.mkdirSync(OUT, { recursive: true });
const hub = await startHub(PORT);
const { browser, page } = await openTv(PORT);
const frames = []; let n = 0;
const snap = async ms => { const f = `f${String(n++).padStart(4, "0")}.png`; await page.screenshot({ path: path.join(OUT, f) }); frames.push({ f, ms }); };
const step = 1000 / FPS, times = []; for (let t = step; t <= CHANGE; t += step) times.push(Math.round(t));
// one lap first, unfilmed: the start-up draws its first screen another way (an instant show), and on the TV the cards'
// accent and frost are written after each change settles, so the filmed lap starts exactly as it ends
for (let k = 0; k < 4; k++) await filmChange(page, [], () => {});
const order = [];
for (let k = 0; k < 4; k++) {                         // four changes: Alaska > Thunderhead > dusk > dawn > Alaska
  order.push(await page.evaluate(() => __state().i));
  await snap(HOLD);                                    // the painting at rest
  await filmChange(page, times, () => snap(Math.round(step)));
}
fs.writeFileSync(path.join(OUT, "frames.json"), JSON.stringify({ fps: FPS, hold: HOLD, order, frames }, null, 1));
console.log(`${frames.length} frames, plates ${order.join(" > ")}, in ${OUT}`);
await browser.close(); hub.kill();
