// Small HTTP helpers shared by the hub and the device agent: JSON replies, bounded bodies, and a static file server
// that cannot be walked out of its folder.
import fs from "node:fs";
import path from "node:path";

export const TYPES = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".webp": "image/webp", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".mp4": "video/mp4",
  ".webm": "video/webm", ".mp3": "audio/mpeg", ".webmanifest": "application/manifest+json",
};
export const typeOf = f => TYPES[path.extname(f).toLowerCase()] || "application/octet-stream";

export function sendJson(res, status, body, extra = {}) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "content-length": Buffer.byteLength(s), ...extra });
  res.end(res.req?.method === "HEAD" ? undefined : s);
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** The request body as parsed JSON, refusing anything over `limit` bytes (413) or not JSON (400). */
export function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers["content-length"]);
    if (len > limit) { req.resume(); return reject(new HttpError(413, `body over ${limit} bytes`)); }
    const chunks = []; let size = 0, done = false;
    req.on("data", c => {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; req.resume(); return reject(new HttpError(413, `body over ${limit} bytes`)); }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return; done = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null")); }
      catch { reject(new HttpError(400, "body is not JSON")); }
    });
    req.on("error", e => { if (!done) { done = true; reject(new HttpError(400, e.message)); } });
  });
}

export const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Map a raw request path to a file under `root`, or null when it must not be served.
 * Works on the raw (still percent-encoded) path, so %2e%2e and %5c are caught as well as ../ and backslashes;
 * refuses Windows tricks (a:b streams, trailing dots or spaces, 8.3 short names, device names); and checks the
 * resolved real path is still inside the real root, so a junction cannot lead out either.
 * `deny(rel)` gets the forward-slash, lower-case path relative to the root and returns true to hide it.
 */
export function resolveSafe(root, rawPath, deny = () => false) {
  let p = String(rawPath || "/").split("?")[0].split("#")[0];
  let decoded;
  try { decoded = decodeURIComponent(p); } catch { return null; }
  if (/[\\\0:*?"<>|]/.test(decoded) || /%/.test(decoded)) return null;      // backslash, NUL, streams, double-encoding
  const segs = decoded.split("/").filter(s => s !== "");
  for (const s of segs) {
    if (s === "." || s === ".." || s.startsWith(".")) return null;            // traversal and every dotfile
    if (/[. ]$/.test(s) || /~\d/.test(s)) return null;                         // "refs." == "refs"; PLATES~1
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s)) return null;
  }
  const rel = segs.join("/");
  if (deny(rel.toLowerCase())) return null;
  const abs = path.resolve(root, ...segs);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  let real, realRoot;
  try { realRoot = fs.realpathSync.native(rootAbs); real = fs.realpathSync.native(abs); } catch { return { abs, rel, missing: true }; }
  if (real !== realRoot && !real.toLowerCase().startsWith(realRoot.toLowerCase() + path.sep)) return null;
  const realRel = path.relative(realRoot, real).split(path.sep).join("/").toLowerCase();
  if (realRel.split("/").some(s => s.startsWith("."))) return null;
  if (deny(realRel)) return null;
  return { abs: real, rel };
}

/** An ETag from size and mtime: cheap, and changes whenever the file does. */
export const etagOf = st => `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;

/**
 * Serve one file with ETag, Last-Modified, 304s, HEAD and a single byte range (for video on the TV).
 * Returns false when there is no such file so the caller can 404.
 */
export function serveFile(req, res, abs, { cacheControl = "no-cache" } = {}) {
  let st;
  try { st = fs.statSync(abs); } catch { return false; }
  if (st.isDirectory()) {
    const idx = path.join(abs, "index.html");
    if (fs.existsSync(idx)) return serveFile(req, res, idx, { cacheControl });
    return false;
  }
  if (!st.isFile()) return false;
  const etag = etagOf(st), lm = new Date(Math.floor(st.mtimeMs / 1000) * 1000).toUTCString();
  const head = { "content-type": typeOf(abs), etag, "last-modified": lm, "cache-control": cacheControl, "accept-ranges": "bytes" };
  const inm = req.headers["if-none-match"], ims = req.headers["if-modified-since"];
  if ((inm && inm.split(/\s*,\s*/).includes(etag)) || (!inm && ims && Date.parse(ims) >= Date.parse(lm))) {
    res.writeHead(304, head); res.end(); return true;
  }
  let start = 0, end = st.size - 1, status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range && st.size > 0) {
    if (range[1] === "" && range[2] !== "") start = Math.max(0, st.size - Number(range[2]));
    else { start = Number(range[1] || 0); if (range[2] !== "") end = Math.min(end, Number(range[2])); }
    if (start > end || start >= st.size) {
      res.writeHead(416, { "content-range": `bytes */${st.size}` }); res.end(); return true;
    }
    status = 206; head["content-range"] = `bytes ${start}-${end}/${st.size}`;
  }
  head["content-length"] = st.size ? end - start + 1 : 0;
  res.writeHead(status, head);
  if (req.method === "HEAD" || !st.size) { res.end(); return true; }
  const s = fs.createReadStream(abs, { start, end });
  s.on("error", () => res.destroy());
  s.pipe(res);
  return true;
}

/** Write a file atomically: a temporary sibling, then a rename over the target. */
export function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** A tiny line logger with a size cap: past `maxBytes` the file becomes <file>.1 (the previous .1 is replaced). */
export function makeLogger(file, { maxBytes = 2 << 20, redact = [] } = {}) {
  return (level, msg) => {
    let line = `${new Date().toISOString()} ${level} ${String(msg).replace(/\s+/g, " ").slice(0, 600)}`;
    for (const r of redact) { const s = typeof r === "function" ? r() : r; if (s) line = line.split(s).join("[redacted]"); }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try { if (fs.statSync(file).size > maxBytes) fs.renameSync(file, file + ".1"); } catch { /* no log yet */ }
      fs.appendFileSync(file, line + "\n");
    } catch { /* logging must never take the hub down */ }
  };
}
