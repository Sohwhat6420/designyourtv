// Play/pause, next and previous for the hub laptop's own media session (what the Now Playing pill shows), so the
// pill's buttons and the TV remote's media keys reach Spotify or YouTube on the desk laptop. One windowless PowerShell per
// press, at most one at a time; a press while one is running is dropped rather than queued.
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PS1 = path.join(path.dirname(fileURLToPath(import.meta.url)), "media-control.ps1");
export const MEDIA_ACTS = new Set(["playpause", "next", "prev"]);

export function createMediaControl({ run } = {}) {
  let busy = false;
  const exec = run || (act => new Promise(resolve => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", PS1, "-Act", act],
      { windowsHide: true, timeout: 10e3 }, (err, stdout) => {
        if (err && !stdout) return resolve({ ok: false, act, why: err.killed ? "timed out" : "PowerShell failed" });
        try { resolve(JSON.parse(String(stdout).trim().split(/\r?\n/).pop())); } catch { resolve({ ok: false, act, why: "no answer" }); }
      });
  }));
  return {
    async press(act) {
      if (!MEDIA_ACTS.has(act)) return { ok: false, act, why: "unknown action" };
      if (process.platform !== "win32" && !run) return { ok: false, act, why: "not Windows" };
      if (busy) return { ok: false, act, why: "busy" };
      busy = true;
      try { return await exec(act); } finally { busy = false; }
    },
  };
}
