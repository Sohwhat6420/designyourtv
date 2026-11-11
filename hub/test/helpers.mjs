// Shared test helpers: an in-process hub with nothing that spawns a process or touches the internet.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHub } from "../server.mjs";

export const tmpDir = tag => fs.mkdtempSync(path.join(os.tmpdir(), `tv-hub-${tag}-`));

export async function quietHub(extra = {}) {
  return createHub({
    port: 0, host: "127.0.0.1", stateDir: tmpDir("state"), monitor: null, phones: null, activityJob: false, log: () => {},
    claude: async () => ({ session: { pct: 12, reset: "2h 00m" }, weekly: { pct: 30, reset: "Fri 10:00" }, read_at: new Date().toISOString(), stale: false, source: "test" }),
    bus: { get: async () => ({ read_at: new Date().toISOString(), stops: [] }), peek: () => null },
    ...extra,
  });
}

/** A raw request: the path is sent exactly as given (no URL normalisation), so traversal attempts reach the server. */
export function raw(port, rawPath, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method, headers }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

/** Collect named SSE events from a URL until `until(events)` is true or the timeout passes. */
export function collectSse(url, until, ms = 4000) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get(url, res => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", d => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev) events.push({ ev, data: data ? JSON.parse(data) : null });
          if (until(events)) { req.destroy(); resolve(events); }
        }
      });
    });
    req.on("error", e => { if (e.code !== "ECONNRESET") reject(e); });
    setTimeout(() => { req.destroy(); resolve(events); }, ms);
  });
}
