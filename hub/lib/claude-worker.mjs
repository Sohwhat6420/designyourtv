// getClaudeUsage() in a worker thread. Its probe uses spawnSync (up to 90 s), which would freeze the hub's event loop
// (every stream, every page) if it ran on the main thread; here it blocks only this worker.
import { parentPort, Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

if (parentPort) {
  const { getClaudeUsage } = await import("./claude-usage.mjs");
  parentPort.on("message", async ({ id, opts }) => {
    try { parentPort.postMessage({ id, result: await getClaudeUsage(opts) }); }
    catch (e) { parentPort.postMessage({ id, error: String(e?.message || e) }); }
  });
}

/** A long-lived worker; get(opts) resolves with the reading (or null). */
export function createClaudeReader() {
  let worker = null, seq = 0;
  const waiting = new Map();
  const boot = () => {
    worker = new Worker(fileURLToPath(import.meta.url));
    worker.unref();
    worker.on("message", ({ id, result, error }) => {
      const w = waiting.get(id); if (!w) return; waiting.delete(id);
      error ? w.reject(new Error(error)) : w.resolve(result);
    });
    worker.on("error", e => { for (const w of waiting.values()) w.reject(e); waiting.clear(); worker = null; });
    worker.on("exit", () => { for (const w of waiting.values()) w.reject(new Error("claude worker exited")); waiting.clear(); worker = null; });
  };
  return {
    get(opts = {}) {
      if (!worker) boot();
      const id = ++seq;
      return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); worker.postMessage({ id, opts }); });
    },
    stop() { worker?.terminate(); worker = null; },
  };
}
