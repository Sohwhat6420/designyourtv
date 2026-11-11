// What the Claude Code sessions on this laptop are waiting on you for: the open questions in every session's waits ledger
// (~/.claude/waits/<session>.json, written by a waits hook of your own; nothing writes it by default). Read-only. Shown in
// the travel laptop's bus slot.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const WAITS_DIR = process.env.WAITS_DIR || path.join(os.homedir(), ".claude", "waits");
export const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
export const FRESH_MS = 72 * 3600e3;            // older than three days: counted, not listed (the session has moved on)


/** The project a session runs in, from the folder its transcript sits in. */
export function projectOf(session, projectsDir = PROJECTS_DIR) {
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir); } catch { return null; }
  const d = dirs.find(x => { try { return fs.existsSync(path.join(projectsDir, x, `${session}.jsonl`)); } catch { return false; } });
  if (!d) return null;
  // the project folder name Claude Code encodes ("C--Users-me-Projects-Garden" -> "Garden")
  return d.replace(/^[A-Za-z]--Users-[^-]+-?/, "").split("-").filter(Boolean).pop() || "Home";
}

/** The ledger's wording turned into what to do. */
export function plainQuestion(q) {
  const s = String(q || "").trim();
  const m = /^start "(.+)" \(refused: needs a message he types in the desktop app\)$/.exec(s);
  if (m) return `Start "${m[1]}": type any message in the desktop app`;
  return s.slice(0, 240);
}

export function createWaitingReader({ dir = WAITS_DIR, projectsDir = PROJECTS_DIR, ttlMs = 30e3 } = {}) {
  let cache = { at: 0, data: null };
  const projects = new Map();
  function read(now = Date.now()) {
    const items = []; let older = 0;
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith(".json")); } catch { /* no ledger yet */ }
    for (const f of files) {
      let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
      const session = f.slice(0, -5);
      for (const w of Array.isArray(j && j.waits) ? j.waits : []) {
        if (!w || !w.id) continue;
        const opened = Number(w.openedAt) || 0;
        if (now - opened > FRESH_MS) { older++; continue; }
        if (!projects.has(session)) projects.set(session, projectOf(session, projectsDir));
        items.push({ id: String(w.id).slice(0, 120), question: plainQuestion(w.question), project: projects.get(session), session: session.slice(0, 8),
          opened_at: new Date(opened).toISOString(), age_min: Math.max(0, Math.round((now - opened) / 60e3)) });
      }
    }
    items.sort((a, b) => b.opened_at.localeCompare(a.opened_at));
    return { read_at: new Date(now).toISOString(), count: items.length, older, items: items.slice(0, 12) };
  }
  return {
    get(now = Date.now()) {
      if (!cache.data || now - cache.at > ttlMs) cache = { at: now, data: read(now) };
      return cache.data;
    },
  };
}
