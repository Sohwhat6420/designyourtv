// Live Claude plan limits (5-hour session and weekly) for the docks and the corner widget.
//
// Two sources, freshest wins; neither ever touches a credential:
//  1. ~/.claude/usage/main.json, if a status-line script of yours writes one (read only here; optional);
//  2. a one-line headless probe: `claude -p ok --model haiku --output-format stream-json --verbose` prints a
//     rate_limit_event carrying both windows' utilisation and reset times. It costs about USD0.0002 of the subscription and runs at most every PROBE_GAP_MIN.
// The probe runs from an empty folder with only project settings (none there), so the owner's user hooks never load,
// windowless, with ANTHROPIC_API_KEY and CLAUDE_CONFIG_DIR removed so it bills and reads the main account.
//
// CLI: node hub/lib/claude-usage.mjs [--probe] [--no-probe] [--out <file>]   prints the reading as JSON
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MIN = 60e3;
export const SNAPSHOT = process.env.TV_CLAUDE_SNAPSHOT || path.join(os.homedir(), ".claude", "usage", "main.json");
export const CLAUDE_EXE = process.env.TV_CLAUDE_EXE || path.join(os.homedir(), ".local", "bin", "claude.exe");
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CACHE = process.env.TV_CLAUDE_CACHE || path.join(HERE, "..", "state", "claude-probe.json");
export const FRESH_MIN = 10;       // a reading younger than this is used as it is
export const PROBE_GAP_MIN = 10;   // never probe more often than this
const PROBE_ARGS = ["-p", "ok", "--model", "haiku", "--output-format", "stream-json", "--verbose", "--max-turns", "1",
  "--system-prompt", "Reply with ok.", "--tools", "", "--strict-mcp-config", "--no-session-persistence",
  "--disable-slash-commands", "--setting-sources", "project", "--max-budget-usd", "0.01"];

const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
const pctOf = u => (num(u) === null ? null : Math.round(Number(u) * 1000) / 10); // 0.39 -> 39

/** The newest rate_limit_event in stream-json output -> {five_hour:{pct,resets_at}, seven_day:{…}, walled}, or null. */
export function parseStream(text) {
  let ev = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.includes("rate_limit_event")) continue;
    try { const j = JSON.parse(line); if (j?.type === "rate_limit_event" && j.rate_limit_info) ev = j.rate_limit_info; } catch { /* torn line */ }
  }
  if (!ev) return null;
  const uw = ev.unifiedWindows || {};
  const win = (w, type) => {
    const at = num(w?.resetsAt ?? (ev.rateLimitType === type ? ev.resetsAt : null));
    let pct = w ? pctOf(w.utilization) : null;
    if (pct === null && ev.status === "rejected" && ev.rateLimitType === type) pct = 100; // a wall with no numbers is full
    return pct === null && at === null ? null : { pct, resets_at: at };
  };
  return { five_hour: win(uw.five_hour, "five_hour"), seven_day: win(uw.seven_day, "seven_day"), walled: ev.status === "rejected" };
}

function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }

/** The harness snapshot, normalised, or null. */
export function readSnapshot(file = SNAPSHOT) {
  const j = readJSON(file);
  if (!j || j.absent || typeof j.at !== "string") return null;
  const w = x => (x && num(x.pct) !== null ? { pct: num(x.pct), resets_at: num(x.resets_at) } : null);
  return { five_hour: w(j.five_hour), seven_day: w(j.seven_day), walled: false, read_at: j.at, source: "harness " + (j.source || "snapshot") };
}

/** Run the probe once. Returns a reading or {error}. `spawn` is injectable for tests. */
export function probe({ spawn = spawnSync, exe = CLAUDE_EXE } = {}) {
  const cwd = path.join(os.tmpdir(), "tv-claude-usage-probe");
  fs.mkdirSync(cwd, { recursive: true });
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; delete env.CLAUDE_CONFIG_DIR; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
  const res = spawn(exe, PROBE_ARGS, { cwd, env, encoding: "utf8", windowsHide: true, timeout: 90e3, maxBuffer: 8 << 20 });
  if (res.error) return { error: "spawn failed: " + (res.error.code || res.error.message) };
  const r = parseStream(res.stdout);
  // 3 Nov: the CLI's own sign-in had lapsed ("OAuth session expired"), which only the owner can renew with `claude` then /login
  if (!r && /Failed to authenticate/.test(res.stdout)) return { error: "signin-expired: run `claude` in a terminal and /login once" };
  if (!r) return { error: `no rate_limit_event (exit ${res.status}): ${String(res.stderr || "").slice(0, 160).replace(/\s+/g, " ")}` };
  return { ...r, read_at: new Date().toISOString(), source: "probe" };
}

/** "2h 34m" until a reset, or a day and time in Singapore when it is more than a day away. */
export function resetLabel(epochSec, now = Date.now()) {
  if (num(epochSec) === null) return "";
  const ms = epochSec * 1000 - now;
  if (ms <= 0) return "now";
  if (ms < 24 * 60 * MIN) {
    const m = Math.ceil(ms / MIN), h = Math.floor(m / 60);
    return h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
  }
  const d = new Date(epochSec * 1000);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "Asia/Singapore" });
  const t = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Singapore" });
  return `${day} ${t}`;
}

/** What the screens draw. A window that has reset since the reading shows 0 % and says so ("new"). */
export function present(r, now = Date.now()) {
  const age = Math.round((now - Date.parse(r.read_at)) / MIN * 10) / 10;
  const win = w => {
    if (!w) return null;
    const expired = num(w.resets_at) !== null && now >= w.resets_at * 1000;
    return { pct: expired ? 0 : w.pct, resets_at: w.resets_at, reset: expired ? "new" : resetLabel(w.resets_at, now), expired };
  };
  return { session: win(r.five_hour), weekly: win(r.seven_day), walled: !!r.walled, read_at: r.read_at, age_min: age,
    stale: !(age <= FRESH_MIN * 3), source: r.source };
}

let probing = null;
/** The one call the hub makes: the freshest reading, probing only when both sources are older than FRESH_MIN. */
export async function getClaudeUsage({ allowProbe = true, forceProbe = false, now = Date.now() } = {}) {
  const fresh = r => r && now - Date.parse(r.read_at) < FRESH_MIN * MIN;
  const snap = readSnapshot(), cached = readJSON(CACHE);
  let best = [snap, cached && !cached.error ? cached : null].filter(Boolean).sort((a, b) => Date.parse(b.read_at) - Date.parse(a.read_at))[0] || null;
  const lastTry = cached ? Date.parse(cached.tried_at || cached.read_at) : 0;
  if (allowProbe && (forceProbe || (!fresh(best) && now - lastTry >= PROBE_GAP_MIN * MIN))) {
    probing ??= new Promise(res => setImmediate(() => res(probe())));
    const p = await probing; probing = null;
    const rec = { ...(p.error ? cached || {} : p), tried_at: new Date().toISOString(), ...(p.error ? { error: p.error } : { error: undefined }) };
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(rec, null, 2));
    if (!p.error) best = p;
  }
  const out = best ? present(best, now) : null;
  const err = readJSON(CACHE)?.error;
  if (out && err) out.probe_error = err;
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), out = a.includes("--out") ? a[a.indexOf("--out") + 1] : null;
  const r = await getClaudeUsage({ allowProbe: !a.includes("--no-probe"), forceProbe: a.includes("--probe") });
  const s = JSON.stringify(r, null, 2);
  if (out) fs.writeFileSync(out, s);
  console.log(s);
}
