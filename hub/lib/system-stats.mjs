// This machine's live stats for the docks: CPU, RAM, GPU, temperatures, battery, disk, network and what is playing.
// Shared by the hub (the desk laptop) and the device agent (the travel laptop and any other Windows laptop).
//   cpu      os.cpus() deltas every 2 s
//   gpu      nvidia-smi every 5 s (execFile, windowless); null on a machine without an NVIDIA GPU
//   cpu temp LibreHardwareMonitor's web server (http://127.0.0.1:8085/data.json) when it is running, else null
//   battery, network, now playing   one long-lived hidden PowerShell (win-sensors.ps1), lines of JSON on stdout
//   disk     fs.statfs on C: every 30 s
// A 60-sample ring (2 s apart, so two minutes) of cpu, gpu and ram backs the sparklines.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SENSORS_PS1 = path.join(HERE, "win-sensors.ps1");
export const RING = 60;
const r1 = n => Math.round(n * 10) / 10;
const GB = 1024 ** 3;

/** Busy share of all cores between two os.cpus() readings, 0-100. */
export function cpuPct(a, b) {
  let idle = 0, total = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const ta = a[i].times, tb = b[i].times;
    const d = k => tb[k] - ta[k];
    const t = d("user") + d("nice") + d("sys") + d("idle") + d("irq");
    idle += d("idle"); total += t;
  }
  return total > 0 ? r1(100 * (1 - idle / total)) : null;
}

/** One nvidia-smi CSV line (nounits) -> the gpu object. */
export function parseNvidiaSmi(text) {
  const line = String(text || "").split(/\r?\n/).find(l => l.trim());
  if (!line) return null;
  const [name, util, temp, used, total, power] = line.split(",").map(s => s.trim());
  const n = s => (s === undefined || /N\/A|\[/.test(s) || s === "" ? null : Number(s));
  return { name, util_pct: n(util), temp_c: n(temp), mem_used_mb: n(used), mem_total_mb: n(total), power_w: n(power) };
}

/** The CPU package temperature from LibreHardwareMonitor's data.json tree, or null. */
export function lhmCpuTemp(tree) {
  const found = [];
  (function walk(n, inCpu) {
    if (!n || typeof n !== "object") return;
    const text = String(n.Text || "");
    const cpu = inCpu || /intel|amd|ryzen|core i\d|cpu/i.test(text) && Array.isArray(n.Children) && n.Children.length > 0;
    if (inCpu && /°C/.test(String(n.Value || "")) && /package|tctl|tdie|cpu/i.test(text)) found.push({ text, v: parseFloat(String(n.Value).replace(",", ".")) });
    for (const c of n.Children || []) walk(c, cpu);
  })(tree, false);
  const pick = found.find(f => /package/i.test(f.text)) || found.find(f => /tctl|tdie/i.test(f.text)) || found[0];
  return pick && Number.isFinite(pick.v) ? pick.v : null;
}

/**
 * Start sampling. Options let tests and non-Windows hosts switch parts off:
 * {device, gpu: true, sensors: true, lhm: true, log}
 * Returns {snapshot(), nowPlaying(), stop(), on(event, fn)}; "nowplaying" fires when the track or state changes.
 */
export function createSystemMonitor({ device = os.hostname(), gpu = true, sensors = process.platform === "win32", lhm = true, log = () => {} } = {}) {
  const timers = [];
  const every = (ms, fn) => { fn(); const t = setInterval(fn, ms); t.unref(); timers.push(t); };
  const listeners = { nowplaying: [] };
  const hist = { t: [], cpu: [], gpu: [], ram: [] };
  const st = { cpu_pct: null, gpu: null, gpu_off: !gpu, cpu_temp_c: null, battery: null, disk: null, net: null,
    np: { status: sensors ? "starting" : "unavailable", why: sensors ? undefined : "sensors off" } };
  let prevCpu = os.cpus(), prevNet = null, ps = null, psFails = [], stopped = false;

  const ram = () => {
    const total = os.totalmem(), used = total - os.freemem();
    return { used_gb: r1(used / GB), total_gb: r1(total / GB), pct: r1(100 * used / total) };
  };

  every(2000, () => {
    const now = os.cpus();
    st.cpu_pct = cpuPct(prevCpu, now); prevCpu = now;
    const push = (k, v) => { hist[k].push(v); if (hist[k].length > RING) hist[k].shift(); };
    push("t", Date.now()); push("cpu", st.cpu_pct); push("gpu", st.gpu ? st.gpu.util_pct : null); push("ram", ram().pct);
  });

  if (gpu) every(5000, () => {
    if (st.gpu_off) return;
    execFile("nvidia-smi", ["--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw", "--format=csv,noheader,nounits"],
      { windowsHide: true, timeout: 4000 }, (err, out) => {
        if (err) {
          if (err.code === "ENOENT") { st.gpu_off = true; st.gpu = null; setTimeout(() => { st.gpu_off = false; }, 5 * 60e3).unref(); }
          return;
        }
        st.gpu = parseNvidiaSmi(out);
      });
  });

  if (lhm) every(5000, async () => {
    try {
      const r = await fetch("http://127.0.0.1:8085/data.json", { signal: AbortSignal.timeout(800) });
      st.cpu_temp_c = r.ok ? lhmCpuTemp(await r.json()) : null;
    } catch { st.cpu_temp_c = null; }
  });

  every(30e3, () => {
    fs.statfs(process.platform === "win32" ? "C:/" : "/", (err, s) => {
      if (err) return;
      st.disk = { drive: process.platform === "win32" ? "C:" : "/", free_gb: r1(s.bavail * s.bsize / GB), total_gb: r1(s.blocks * s.bsize / GB) };
    });
  });

  function emitNp(next) {
    const key = n => JSON.stringify([n.status, n.title, n.artist, n.album, n.app, n.duration_s]);
    const changed = key(next) !== key(st.np);
    st.np = { ...next, read_at: new Date().toISOString() };
    if (changed) for (const fn of listeners.nowplaying) fn(st.np);
  }

  function startSensors() {
    if (stopped) return;
    ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SENSORS_PS1, String(process.pid)],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    ps.stdout.setEncoding("utf8");
    ps.stdout.on("data", d => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.kind === "np") { const { kind, ...rest } = j; emitNp(rest); }
        else if (j.kind === "idle") st.idle_s = j.s >= 0 ? j.s : null;
        else if (j.kind === "commit") st.commit = j.limit_gb > 0 ? { used_gb: j.used_gb, limit_gb: j.limit_gb, pct: r1(100 * j.used_gb / j.limit_gb) } : null;
        else if (j.kind === "battery") st.battery = j.present ? { pct: j.pct, charging: !!j.charging, plugged: !!j.plugged } : null;
        else if (j.kind === "net") {
          if (prevNet && j.at > prevNet.at) {
            const s = (j.at - prevNet.at) / 1000;
            st.net = { down_kbps: r1(Math.max(0, j.rx - prevNet.rx) / 1024 / s), up_kbps: r1(Math.max(0, j.tx - prevNet.tx) / 1024 / s) };
          }
          prevNet = j;
        } else if (j.kind === "error") log("warn", `sensor ${j.sensor}: ${j.why}`);
      }
    });
    ps.stderr.on("data", d => log("warn", `win-sensors: ${String(d).slice(0, 200)}`));
    ps.on("error", e => log("warn", `win-sensors spawn: ${e.message}`));
    ps.on("exit", code => {
      ps = null;
      if (stopped) return;
      const now = Date.now();
      psFails = psFails.filter(t => now - t < 10 * 60e3).concat(now);
      if (psFails.length >= 5) {
        emitNp({ status: "unavailable", why: "the sensors helper keeps exiting" });
        log("error", `win-sensors exited ${code} five times in 10 min; retrying in 10 min`);
        setTimeout(startSensors, 10 * 60e3).unref();
      } else setTimeout(startSensors, 30e3).unref();
    });
  }
  if (sensors) startSensors();

  return {
    device,
    on(ev, fn) { (listeners[ev] ||= []).push(fn); },
    nowPlaying: () => st.np,
    snapshot() {
      return {
        device, hostname: os.hostname(), platform: process.platform, read_at: new Date().toISOString(), uptime_s: Math.round(os.uptime()),
        cpu_pct: st.cpu_pct, cpu_model: os.cpus()[0]?.model?.trim() || null, cores: os.cpus().length, cpu_temp_c: st.cpu_temp_c,
        ram: { ...ram(), commit_pct: st.commit ? st.commit.pct : null, commit: st.commit || null }, gpu: st.gpu, battery: st.battery, disk: st.disk, net: st.net, idle_s: st.idle_s ?? null,
        history: { interval_s: 2, cpu: [...hist.cpu], gpu: [...hist.gpu], ram: [...hist.ram] },
      };
    },
    stop() {
      stopped = true;
      timers.forEach(clearInterval);
      if (ps) { try { ps.kill(); } catch { /* gone */ } }
    },
  };
}
