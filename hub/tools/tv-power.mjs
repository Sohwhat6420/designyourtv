#!/usr/bin/env node
// Switch the TV on or off, or read its state, in one line (from a terminal, a script or an agent on the hub machine).
// The power logic lives in hub/lib/tv-power.mjs.
//   node hub/tools/tv-power.mjs on|off|status [--direct] [--no-cast] [--cast-only] [--deep] [--json] [--hub http://127.0.0.1:8790]
//   --no-cast: `on` never tries the Cast fallback. --cast-only: `on` tries only Cast (the live test of that path).
//   tools/tv-guard.mjs: `off` is refused while another app (YouTube...) is in front. --user-said-so overrides that, and is only for
//   when the person in the room asked for it; an unattended script never passes it.
// It asks the hub first (POST /api/tv/power, GET /api/tv/status), so the hub's keeper and its state stay the one
// record; when the hub is down, or is an older build without the TV routes, it does the same thing itself over adb.
// Exit codes: 0 done, 1 it did not work, 2 bad arguments.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTvKeeper, statusLine } from "../lib/tv-power.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const action = args.find(a => !a.startsWith("--") && a !== opt("--hub", null));
const hub = opt("--hub", process.env.TV_HUB || "http://127.0.0.1:8790").replace(/\/$/, "");

if (!["on", "off", "status"].includes(action)) {
  console.error("usage: node hub/tools/tv-power.mjs on|off|status [--direct] [--no-cast] [--cast-only] [--deep] [--json] [--hub <url>]");
  process.exit(2);
}

function print(r, where) {
  if (flag("--json")) console.log(JSON.stringify({ ...r, where }, null, 1));
  else if (action === "status") console.log(`${r.result || statusLine(r)}  [${where}]`);
  else console.log(`TV ${action}: ${r.ok ? "OK" : "FAILED"}, ${r.result}${r.ms != null ? ` (${(r.ms / 1000).toFixed(1)} s)` : ""}  [${where}]`
    + (r.steps?.length && !r.ok ? `\n  steps: ${r.steps.join(", ")}` : ""));
  process.exitCode = r.ok === false ? 1 : 0;
}

async function viaHub() {
  const timeout = AbortSignal.timeout(action === "on" ? 150e3 : 60e3);
  const res = action === "status"
    ? await fetch(`${hub}/api/tv/status?fresh=1`, { signal: timeout })
    : await fetch(`${hub}/api/tv/power`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, cast: !flag("--no-cast"), cast_only: flag("--cast-only"), explicit: flag("--user-said-so"), deep: flag("--deep") }), signal: timeout });
  if (res.status === 404 || res.status === 503) return null;          // an older hub, or one without a keeper
  const body = await res.json();
  return action === "status" ? { ok: true, result: statusLine(body), ...body } : body;
}

async function direct() {
  const k = createTvKeeper({ stateFile: path.join(HERE, "..", "state", "tv.json") });
  return k.power(action, { cast: !flag("--no-cast"), castOnly: flag("--cast-only"), explicit: flag("--user-said-so"), deep: flag("--deep") });
}

let r = null, where = "hub";
if (!flag("--direct")) {
  try { r = await viaHub(); } catch (e) { if (e.name === "TimeoutError") { console.log(`TV ${action}: the hub did not answer in time; it may still be working (check: node hub/tools/tv-power.mjs status)`); process.exit(1); } }
}
if (!r) { where = "direct"; r = await direct(); }
print(r, where);
