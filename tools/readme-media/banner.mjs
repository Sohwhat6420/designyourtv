#!/usr/bin/env node
// The repository banner and social preview (1280 x 640) and the LinkedIn size (1200 x 627), in the profile README's card
// style: dark glass, an amber eyebrow, the TV's serif and interface faces. The picture is a real frame of the TV page
// (film-stills.mjs: Raptors over Alaska at 2x), only scaled. Every figure on it is checked (see docs/numbers.md).
//   node tools/readme-media/banner.mjs <stills dir> [<assets dir>]
import fs from "node:fs";
import path from "node:path";
import { chromium, HERE, ROOT } from "./lib.mjs";

const stills = path.resolve(process.argv[2]), assets = path.resolve(process.argv[3] || path.join(ROOT, "assets"));
fs.mkdirSync(assets, { recursive: true });
const font = (fam, file, w) => `@font-face{font-family:"${fam}";src:url("file://${path.join(HERE, "fonts", file)}");font-weight:${w}}`;
const FACTS = ["164 tests in CI", "0 npm dependencies"];
const page = (W, H) => { const u = W / 1280; return `<!doctype html><meta charset="utf-8"><style>
${font("Hanken", "HankenGrotesk-Regular.ttf", 400)}${font("Hanken", "HankenGrotesk-Medium.ttf", 500)}${font("Hanken", "HankenGrotesk-SemiBold.ttf", 600)}
${font("Serif", "InstrumentSerif-Regular.ttf", 400)}
html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden}
body{position:relative;background:#0e1013;font-family:Hanken;color:#f4f3ef;-webkit-font-smoothing:antialiased}
.glow{position:absolute;inset:0;background:radial-gradient(70% 90% at 0% 0%,rgba(217,183,122,.11),transparent 60%),radial-gradient(60% 80% at 100% 100%,rgba(120,140,190,.10),transparent 60%)}
.grain{position:absolute;inset:0;opacity:.05;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='2' stitchTiles='stitch'/></filter><rect width='160' height='160' filter='url(%23n)'/></svg>")}
.col{position:absolute;left:${64 * u}px;top:0;bottom:0;width:${450 * u}px;display:flex;flex-direction:column;justify-content:center}
.eb{font:600 ${18 * u}px/1 Hanken;letter-spacing:.14em;color:#d9b77a}
h1{font:400 ${86 * u}px/1 Serif;letter-spacing:-.01em;margin:${16 * u}px 0 ${20 * u}px -${4 * u}px}
.l1{font:500 ${33 * u}px/1.18 Hanken;margin:0}
.l2{font:400 ${21 * u}px/1.4 Hanken;color:#b8bcc4;margin:${14 * u}px 0 0}
.chips{display:flex;gap:${10 * u}px;flex-wrap:wrap;margin-top:${30 * u}px}
.chip{font:500 ${19 * u}px/1 Hanken;padding:${11 * u}px ${15 * u}px;border-radius:99px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);color:#e6e4de}
.chip b{font-weight:600;color:#ffb340}
.tv{position:absolute;left:${560 * u}px;top:50%;width:${800 * u}px;aspect-ratio:16/9;translate:0 -50%;border-radius:${16 * u}px 0 0 ${16 * u}px;overflow:hidden;
  box-shadow:0 ${24 * u}px ${64 * u}px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.16)}
.tv img{width:100%;height:100%;display:block}
.cap{position:absolute;left:${560 * u}px;bottom:${(H - (H / 2 + 225 * u)) / 2 - 7 * u}px;font:500 ${13 * u}px/1 Hanken;letter-spacing:.1em;color:#8f949c;opacity:.75}
</style><div class="glow"></div><div class="grain"></div>
<div class="col"><div class="eb">GOOGLE TV \u00b7 ANDROID TV \u00b7 MIT</div><h1>designyourtv</h1>
<p class="l1">The clock stands behind<br>the painting.</p>
<p class="l2">A screensaver for Google TV and Android TV.</p>
<div class="chips">${FACTS.map(f => { const [n, ...r] = f.split(" "); return `<span class="chip"><b>${n}</b> ${r.join(" ")}</span>`; }).join("")}</div></div>
<div class="tv"><img src="file://${path.join(stills, "rest-f22-alaska.png")}"></div>
<div class="cap">A REAL FRAME FROM THE DEMO</div>`; };
const browser = await chromium.launch();
for (const [W, H, name] of [[1280, 640, "banner-1280x640.png"], [1200, 627, "banner-linkedin-1200x627.png"]]) {
  const p = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const html = path.join(stills, `banner-${W}.html`); fs.writeFileSync(html, page(W, H));
  await p.goto("file://" + html); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(assets, name) });
  console.log(name, (fs.statSync(path.join(assets, name)).size / 1024).toFixed(0) + " KB");
}
await browser.close();
