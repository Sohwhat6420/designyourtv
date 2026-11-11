// The one configuration every screen draws from: hub/state/config.json, shape {choices:{<plateId>:{…}}, globals:{tv:{…}}, updatedAt}.
// Writes are atomic (temporary file, then rename) and the version being replaced is kept in config-history/, newest 20.
// PATCH follows JSON Merge Patch (RFC 7386): objects merge key by key, arrays and values replace, null removes a key.
import fs from "node:fs";
import path from "node:path";
import { writeAtomic, isPlainObject, HttpError } from "./http-util.mjs";

export const KEEP_VERSIONS = 20;
export const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** RFC 7386 merge, never touching prototype keys. Returns a new value; inputs are left alone. */
export function mergePatch(target, patch) {
  if (!isPlainObject(patch)) return structuredClone(patch);
  const out = isPlainObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (BAD_KEYS.has(k)) continue;
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

/** Drop prototype keys anywhere in a parsed document. */
function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (!isPlainObject(v)) return v;
  const o = {};
  for (const [k, x] of Object.entries(v)) if (!BAD_KEYS.has(k)) o[k] = scrub(x);
  return o;
}

export function createConfigStore(stateDir, { onChange = () => {} } = {}) {
  const file = path.join(stateDir, "config.json");
  const histDir = path.join(stateDir, "config-history");
  const empty = () => ({ choices: {}, globals: {}, updatedAt: null });
  let doc = (() => {
    try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return isPlainObject(j) ? { ...empty(), ...j } : empty(); }
    catch { return empty(); }
  })();

  function keepHistory() {
    if (!fs.existsSync(file)) return;
    fs.mkdirSync(histDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let name = `config-${stamp}.json`, n = 1;
    while (fs.existsSync(path.join(histDir, name))) name = `config-${stamp}-${n++}.json`;
    fs.copyFileSync(file, path.join(histDir, name));
    const all = fs.readdirSync(histDir).filter(f => /^config-.*\.json$/.test(f)).sort();
    // Only the oldest versions beyond the newest 20 go; they are the store's own copies, not the owner's files.
    for (const f of all.slice(0, Math.max(0, all.length - KEEP_VERSIONS))) fs.rmSync(path.join(histDir, f), { force: true });
  }

  function save(next, what) {
    next.updatedAt = new Date().toISOString();
    keepHistory();
    writeAtomic(file, JSON.stringify(next, null, 2));
    doc = next;
    onChange({ updatedAt: next.updatedAt, what });
    return doc;
  }

  return {
    file, histDir,
    get: () => doc,
    history: () => { try { return fs.readdirSync(histDir).filter(f => f.endsWith(".json")).sort(); } catch { return []; } },
    put(body) {
      if (!isPlainObject(body)) throw new HttpError(400, "config must be a JSON object");
      for (const k of ["choices", "globals"]) if (k in body && !isPlainObject(body[k])) throw new HttpError(400, `${k} must be an object`);
      const clean = scrub(body);
      return save({ ...empty(), ...clean }, "all");
    },
    patch(section, id, body) {
      if (section !== "choices" && section !== "globals") throw new HttpError(404, "no such section");
      if (!ID_RE.test(id) || BAD_KEYS.has(id)) throw new HttpError(400, "bad id");
      if (!isPlainObject(body)) throw new HttpError(400, "patch must be a JSON object");
      const next = structuredClone(doc);
      next[section] = isPlainObject(next[section]) ? next[section] : {};
      next[section][id] = mergePatch(next[section][id], body);
      return save(next, `${section}/${id}`);
    },
  };
}
