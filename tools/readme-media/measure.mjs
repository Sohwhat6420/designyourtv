#!/usr/bin/env node
// Measures the TV page as the README reports it: what it downloads, what it costs at rest, and its frame times while
// the painting changes. The demo hub, the real page at 1920 x 1080 with its real clock, in Playwright's headless
// Chromium on this machine (software rendering: no GPU), so the costs are this machine's, not a TV's.
//   node tools/readme-media/measure.mjs [--idle 60] [--changes 6] > numbers.json
import fs from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";
import { startHub, openTv } from "./lib.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const IDLE = +arg("--idle", 60), CHANGES = +arg("--changes", 6), PORT = +arg("--port", 8797);
// counts every timer and animation-frame callback the page runs (its wakeups), before any of its own script
const COUNT = `(() => { const c = window.__wake = { timeout: 0, interval: 0, raf: 0 };
  const st = window.setTimeout, si = window.setInterval, ra = window.requestAnimationFrame;
  window.setTimeout = (f, ...a) => st(typeof f === "function" ? (...x) => { c.timeout++; return f(...x); } : f, ...a);
  window.setInterval = (f, ...a) => si(typeof f === "function" ? (...x) => { c.interval++; return f(...x); } : f, ...a);
  window.requestAnimationFrame = f => ra(t => { c.raf++; return f(t); }); })();`;
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const r1 = v => Math.round(v * 10) / 10;
// CPU seconds of every Chromium process (utime + stime from /proc), and the renderer's proportional memory
const chromePids = () => execSync("pgrep -f 'chrom(e|ium)'").toString().trim().split(/\s+/).map(Number);
const cpuOf = pid => { try { const f = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" "); return (+f[11] + +f[12]) / os.constants?.CLK_TCK || (+f[11] + +f[12]) / 100; } catch { return 0; } };
const cpuAll = () => chromePids().reduce((s, p) => s + cpuOf(p), 0);
const rendererPss = () => { let best = 0; for (const p of chromePids()) { try { const cmd = fs.readFileSync(`/proc/${p}/cmdline`, "utf8"); if (!cmd.includes("--type=renderer")) continue;
  const m = /Pss:\s+(\d+)/.exec(fs.readFileSync(`/proc/${p}/smaps_rollup`, "utf8")); if (m) best = Math.max(best, +m[1]); } catch {} } return best / 1024; };

const out = { when: new Date().toISOString(), machine: { cpus: os.cpus().length, model: os.cpus()[0].model, node: process.version }, browser: null };
const log = m => process.stderr.write(`[${((Date.now() - T0) / 1e3).toFixed(0)} s] ${m}\n`), T0 = Date.now();
const hub = await startHub(PORT, undefined, { realClock: true });
log("hub up");
const { browser, page } = await openTv(PORT, { fixed: false, init: COUNT });
out.browser = "Chromium " + browser.version() + " (Playwright, headless, software rendering)";

// 1. payload: every response while the page loaded
// (the hub's server-sent events never end, so streams are left out; any other body gets 5 s)
const body = r => Promise.race([r.body().then(b => b.length), new Promise(res => setTimeout(() => res(0), 5000))]).catch(() => 0);
const items = await Promise.all(page.responses.filter(r => !/event-stream/.test(r.headers()["content-type"] || "")).map(async r => { const n = await body(r); const h = r.headers();
  return { url: r.url(), bytes: n, wire: +(h["content-length"] || 0) || null, enc: h["content-encoding"] || null }; }));
const local = items.filter(i => i.url.startsWith("http://127.0.0.1")), fonts = items.filter(i => /fonts\.(googleapis|gstatic)\.com/.test(i.url));
const kb = a => r1(a.reduce((s, i) => s + i.bytes, 0) / 1024);
out.payload = { requests: items.length, total_kb: kb(items), hub: { requests: local.length, kb: kb(local),
  largest: local.sort((a, b) => b.bytes - a.bytes).slice(0, 6).map(i => [i.url.replace(/^http:\/\/127\.0\.0\.1:\d+\//, ""), r1(i.bytes / 1024), i.enc]) },
  google_fonts: { requests: fonts.length, kb: kb(fonts) } };

log("loaded");
// 2. at rest: IDLE seconds after everything has settled
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(m => [m.name, m.value]));
await page.waitForTimeout(5000);
const m0 = await metrics(), w0 = await page.evaluate(() => ({ ...window.__wake })), c0 = cpuAll(), t0 = Date.now();
await page.waitForTimeout(IDLE * 1000);
const m1 = await metrics(), w1 = await page.evaluate(() => ({ ...window.__wake })), c1 = cpuAll(), secs = (Date.now() - t0) / 1000;
const per = (k, a, b) => r1((b[k] - a[k]) / secs * 60);
out.idle = { seconds: r1(secs),
  main_thread_busy_pct: r1((m1.TaskDuration - m0.TaskDuration) / secs * 100), script_ms_per_min: r1((m1.ScriptDuration - m0.ScriptDuration) * 1000 / secs * 60),
  chromium_cpu_pct_all_processes: r1((c1 - c0) / secs * 100),
  wakeups_per_min: { timeout: per("timeout", w0, w1), interval: per("interval", w0, w1), animation_frame: per("raf", w0, w1) },
  style_recalcs_per_min: per("RecalcStyleCount", m0, m1), layouts_per_min: per("LayoutCount", m0, m1),
  js_heap_used_mb: r1(m1.JSHeapUsedSize / 1048576), renderer_pss_mb: r1(rendererPss()), dom_nodes: m1.Nodes,
  running_css_animations: await page.evaluate(() => document.getAnimations().filter(a => a.playState === "running").map(a => a.animationName || a.transitionProperty || "script")) };

log("idle done");
// 3. the change, in real time: the page's own frame recorder (__perf, rAF deltas) over each change
const deltas = [], cost = [];
for (let k = 0; k < CHANGES; k++) {
  await page.waitForFunction(() => window.__ready(), null, { timeout: 60e3 });
  log("change " + (k + 1));
  await page.waitForTimeout(1500);
  const d = await page.evaluate(() => new Promise(res => { window.__perf.begin(); window.__swap(1); setTimeout(() => { const v = window.__perf.d.map(x => x[1]); window.__perf.end(); res(v); }, 2000); }));
  deltas.push(...d.slice(1));
  cost.push(await page.evaluate(() => (window.__cost || []).at(-1)));
}
out.change = { changes: CHANGES, frames: deltas.length, frame_ms: { median: r1(q(deltas, .5)), p95: r1(q(deltas, .95)), max: r1(Math.max(...deltas)) },
  over_20ms: deltas.filter(d => d > 20).length, fps_median: r1(1000 / q(deltas, .5)),
  plan_ms: { freeze: r1(q(cost.map(c => c.freeze), .5)), measure: r1(q(cost.map(c => c.measure), .5)), write: r1(q(cost.map(c => c.write), .5)), clock: r1(q(cost.map(c => c.clock), .5)) } };
console.log(JSON.stringify(out, null, 1));
await browser.close(); hub.kill();
