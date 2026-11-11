#!/usr/bin/env node
// emu-test.mjs: proves the designyourtv APK on a real Android runtime before the TV is reachable.
// Boots the laptop's API 33 AVD headless and read-only (nothing it does is kept), installs apk/tv-dream/designyourtv.apk
// and a code-free stand-in package called com.anthropic.claude (Claude itself is arm64-only and can't run on x86_64),
// then checks: HOME alias off; tile without the grant leaves density alone; with the grant the tile sets 240 dpi and
// opens "Claude"; Home puts the density back; a density someone else set is never overwritten; restore extra;
// a crash then a reboot is put right by the boot receiver; the screensaver and the Wallpaper page render.
// Stops the emulator it started (by its own console, then by PID tree). Every child is windowsHide.
//   node tools/test/emu-test.mjs [--keep-shots <dir>]      exit 0 = every check passed
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, "..", "..");
const SDK = path.join(os.homedir(), "AppData", "Local", "Android", "Sdk");
const ADB = process.env.ADB || path.join(os.homedir(), "AppData", "Local", "Microsoft", "WinGet", "Packages",
  "Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe", "scrcpy-win64-v4.1", "adb.exe");
const EMU = path.join(SDK, "emulator", "emulator.exe");
const AVD = "AndroidWorldAvd", PORT = 5584, SERIAL = `emulator-${PORT}`;
const APK = path.join(PROJECT, "apk", "tv-dream", "designyourtv.apk");
const KS = path.join(PROJECT, "apk", "tv-dream", "debug.jks");
const shotsArg = process.argv.indexOf("--keep-shots");
const SHOTS = shotsArg > 0 ? process.argv[shotsArg + 1] : fs.mkdtempSync(path.join(os.tmpdir(), "designyourtv-shots-"));
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
function sh(file, args, opt = {}) {
  return execFileSync(file, args, { windowsHide: true, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"], timeout: 120000, ...opt });
}
// Every adb call names the emulator; the adb server is shared with the POCO, so no server commands at all.
function adb(...args) {
  for (const a of args) if (/^(kill-server|start-server|reconnect|disconnect|connect|pair|tcpip|usb|root|unroot|remount|-s)$/.test(a)) throw new Error(`emu-test refuses adb ${a}`);
  return sh(ADB, ["-s", SERIAL, ...args]);
}
const shell = cmd => adb("shell", cmd).replace(/\r/g, "");
const results = [];
function check(name, ok, detail = "") { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); }
function override() { const m = /Override density: (\d+)/.exec(shell("wm density")); return m ? Number(m[1]) : null; }
async function until(fn, ms, step = 500) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); } return v; }
function top() { const o = shell("dumpsys activity activities"); const m = /(?:topResumedActivity|mResumedActivity|ResumedActivity)[^\n]*?\{[^}]*?\s([\w.]+)\/([\w.$]+)/.exec(o); return m ? `${m[1]}/${m[2]}` : ""; }
function shot(name) { const png = execFileSync(ADB, ["-s", SERIAL, "exec-out", "screencap", "-p"], { windowsHide: true, maxBuffer: 64 << 20 }); const f = path.join(SHOTS, name + ".png"); fs.writeFileSync(f, png); return { f, bytes: png.length }; }

/* memory gate: the emulator adds about 2.5 GB; the device rule is under 75 % committed */
const mem = sh("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  "$o=Get-CimInstance Win32_OperatingSystem; [string]::Format('{0} {1}', ($o.TotalVirtualMemorySize-$o.FreeVirtualMemory), $o.TotalVirtualMemorySize)"]).trim().split(/\s+/).map(Number);
const projected = Math.round(100 * (mem[0] + 2.5 * 1048576) / mem[1]);
console.log(`memory: ${(mem[0] / 1048576).toFixed(1)} of ${(mem[1] / 1048576).toFixed(1)} GB committed; with the emulator about ${projected} %`);
if (projected >= 75) { console.error("memory gate: the emulator would take the laptop to 75 % or more; not starting it."); process.exit(5); }
if (!fs.existsSync(APK)) { console.error("build the APK first: node tools/build-tv-apk.mjs"); process.exit(1); }
if (sh(ADB, ["devices"]).includes(SERIAL)) { console.error(`${SERIAL} is already attached; not starting a second one.`); process.exit(1); }

/* the stand-in "Claude": a manifest-only package whose launcher activity is the framework's own Activity class */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "designyourtv-emu-"));
const bt = path.join(SDK, "build-tools", fs.readdirSync(path.join(SDK, "build-tools")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop());
fs.writeFileSync(path.join(tmp, "AndroidManifest.xml"), `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.anthropic.claude">
  <application android:hasCode="false" android:label="Claude stand-in">
    <activity android:name="android.app.Activity" android:exported="true">
      <intent-filter><action android:name="android.intent.action.MAIN" /><category android:name="android.intent.category.LAUNCHER" /></intent-filter>
    </activity>
  </application>
</manifest>
`);
const stub = path.join(tmp, "stub.apk"), stubAligned = path.join(tmp, "stub-aligned.apk"), stubSigned = path.join(tmp, "claude-standin.apk");
sh(path.join(bt, "aapt2.exe"), ["link", "-I", path.join(SDK, "platforms", "android-34", "android.jar"), "--manifest", path.join(tmp, "AndroidManifest.xml"),
  "--min-sdk-version", "23", "--target-sdk-version", "33", "-o", stub]);
sh(path.join(bt, "zipalign.exe"), ["-p", "-f", "4", stub, stubAligned]);
sh(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${path.join(bt, "apksigner.bat")}" sign --ks "${KS}" --ks-key-alias designyourtv --ks-pass pass:android --key-pass pass:android --out "${stubSigned}" "${stubAligned}""`],
  { windowsVerbatimArguments: true });

/* boot */
const logFile = path.join(tmp, "emulator.log");
const out = fs.openSync(logFile, "w");
const emu = spawn(EMU, ["-avd", AVD, "-port", String(PORT), "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot", "-read-only",
  "-memory", "2048", "-gpu", "swiftshader_indirect", "-no-metrics"], { windowsHide: true, stdio: ["ignore", out, out] });
console.log(`emulator PID ${emu.pid} (log ${logFile})`);
let code = 1;
try {
  const booted = await until(() => { try { return shell("getprop sys.boot_completed").trim() === "1"; } catch { return false; } }, 300000, 2000);
  if (!booted) throw new Error("the emulator did not boot within 5 minutes");
  await sleep(4000);
  check("emulator booted (API " + shell("getprop ro.build.version.sdk").trim() + ")", true);
  shell("settings put global window_animation_scale 0; settings put global transition_animation_scale 0; settings put global animator_duration_scale 0; svc power stayon true; input keyevent 224; wm dismiss-keyguard");

  check("install designyourtv.apk", /Success/.test(adb("install", "-r", "-t", APK)));
  check("install the Claude stand-in", /Success/.test(adb("install", "-r", "-t", stubSigned)));
  const homes = shell("cmd package query-activities -a android.intent.action.MAIN -c android.intent.category.HOME");
  check("HOME alias ships off (not offered as a home screen)", !/dev\.designyourtv/.test(homes));
  const base = override();
  check("no density override before the tile runs", base === null, `override ${base}`);

  // without the grant: Claude opens at the TV's own size and nothing is changed
  shell("am start -W -n dev.designyourtv/.ClaudeTile");
  const t0 = await until(() => top().startsWith("com.anthropic.claude/"), 10000);
  check("tile without the grant opens Claude", t0, top());
  check("tile without the grant leaves density alone", override() === null, `override ${override()}`);
  shell("input keyevent 3"); await sleep(1500);

  // the one-time grants the runbook gives
  shell("pm grant dev.designyourtv android.permission.WRITE_SECURE_SETTINGS");
  shell("appops set dev.designyourtv GET_USAGE_STATS allow");
  check("WRITE_SECURE_SETTINGS granted", /WRITE_SECURE_SETTINGS: granted=true/.test(shell("dumpsys package dev.designyourtv")));

  shell("logcat -c");
  shell("am start -W -n dev.designyourtv/.ClaudeTile --ei dpi 240");
  const set = await until(() => override() === 240, 8000);
  check("tile sets 240 dpi", set, `override ${override()}`);
  const tileLog = shell("logcat -d -s DesignYourTV:V").split("\n").filter(l => /DesignYourTV/.test(l)).slice(-12);
  if (tileLog.length) console.log("      tile log:\n" + tileLog.map(l => "        " + l.trim()).join("\n"));
  check("tile opens Claude in front", await until(() => top().startsWith("com.anthropic.claude/"), 8000), top());
  shot("01-claude-240dpi");
  check("guard service running while Claude is in front", /ServiceRecord[^\n]*DensityGuardService/.test(shell("dumpsys activity services dev.designyourtv")));
  shell("input keyevent 3");
  const back = await until(() => override() === null, 15000);
  check("Home puts the density back", back, `override ${override()}`);
  if (!back) console.log("      log:\n" + shell("logcat -d -s DesignYourTV:V").split("\n").filter(l => /DesignYourTV/.test(l)).slice(-8).map(l => "        " + l.trim()).join("\n"));
  check("guard service stops itself afterwards", await until(() => !/ServiceRecord[^\n]*DensityGuardService/.test(shell("dumpsys activity services dev.designyourtv")), 8000));

  // someone else changes the density while Claude is open: the guard must not overwrite it
  shell("am start -W -n dev.designyourtv/.ClaudeTile");
  await until(() => override() === 240, 8000);
  shell("wm density 300");
  shell("input keyevent 3");
  await sleep(6000);
  check("a density set by someone else is left alone", override() === 300, `override ${override()}`);
  shell("wm density reset");

  // the restore extra
  shell("am start -W -n dev.designyourtv/.ClaudeTile");
  await until(() => override() === 240, 8000);
  // sent at once, while the tile may still be open, exactly as tv-apply --tile restore sends it
  shell("am start -W --activity-clear-task -n dev.designyourtv/.ClaudeTile --ez restore true");
  const r1 = await until(() => override() === null, 6000);
  check("--ez restore true puts it back (tile still open)", r1, `override ${override()}`);
  if (!r1) console.log("      log:\n" + shell("logcat -d -s DesignYourTV:V").split("\n").filter(l => /DesignYourTV/.test(l)).slice(-8).map(l => "        " + l.trim()).join("\n"));
  shell("input keyevent 3"); await sleep(4500);
  // sent once Claude is in front (the runbook's step tile-restore)
  shell("am start -W -n dev.designyourtv/.ClaudeTile");
  await until(() => override() === 240, 8000);
  await until(() => top().startsWith("com.anthropic.claude/"), 8000);
  shell("am start -W --activity-clear-task -n dev.designyourtv/.ClaudeTile --ez restore true");
  const r2 = await until(() => override() === null, 6000);
  check("--ez restore true puts it back (Claude in front)", r2, `override ${override()}`);
  if (!r2) console.log("      log:\n" + shell("logcat -d -s DesignYourTV:V").split("\n").filter(l => /DesignYourTV/.test(l)).slice(-8).map(l => "        " + l.trim()).join("\n"));
  shell("input keyevent 3"); await sleep(4500);

  // crash, then reboot with the override still set: the boot receiver must put it back
  shell("am start -W -n dev.designyourtv/.ClaudeTile");
  await until(() => override() === 240, 8000);
  try { shell("am crash dev.designyourtv"); } catch { }
  await sleep(1500);
  const stuck = override();
  console.log(`      after the crash, override ${stuck} (stuck until boot or the next open)`);
  adb("reboot");
  await sleep(8000);
  const reb = await until(() => { try { return shell("getprop sys.boot_completed").trim() === "1"; } catch { return false; } }, 300000, 2000);
  check("rebooted", reb);
  shell("input keyevent 224; wm dismiss-keyguard");
  check("boot receiver puts the density back after a reboot", await until(() => override() === null, 60000, 2000), `override ${override()}`);

  // the screensaver and the Wallpaper page
  shell("settings put secure screensaver_components dev.designyourtv/.WallDream; settings put secure screensaver_enabled 1");
  check("screensaver set to the designyourtv dream", /dev\.designyourtv\/\.WallDream/.test(shell("settings get secure screensaver_components")));
  shell("input keyevent 3"); await sleep(1500);
  const home = shot("02a-home-before-dream");
  // IDreamManager.dream() is transaction 1 (what Settings' "Start now" calls); measured working on API 33, 3 Nov.
  // (cmd dreams has no shell command on 13, and Somnambulator did not start a dream on this image.)
  const how = "service call dreams 1";
  shell("service call dreams 1");
  const inDream = () => { const d = shell("dumpsys dreams"); return /mCurrentDream[^\n]*dev\.designyourtv/.test(d) || /DreamRecord[^\n]*dev\.designyourtv/.test(d) || /dreaming=true/.test(d) && /dev\.designyourtv/.test((/mCurrentDream[\s\S]{0,400}/.exec(d) || [""])[0]); };
  const dreaming = await until(inDream, 15000, 1000);
  check(`the dream starts (${how})`, dreaming, dreaming ? "" : shell("dumpsys dreams").split("\n").filter(l => /Dream|dream/.test(l)).slice(0, 12).join(" | "));
  await sleep(9000);
  const s1 = shot("02-dream");
  check("the dream shows something other than the home screen", s1.bytes > 20000 && Math.abs(s1.bytes - home.bytes) > 50000, `${s1.bytes} vs home ${home.bytes} bytes`);
  shell("input keyevent 4"); await sleep(1500);
  shell("am start -W -n dev.designyourtv/.HomeActivity");
  await sleep(9000);
  const s2 = shot("03-wallpaper-page");
  check("Wallpaper page in front", top().startsWith("dev.designyourtv/"), top());
  check("Wallpaper page draws something", s2.bytes > 20000, `${s2.bytes} bytes`);
  const lc = shell("logcat -d -s DesignYourTV:V chromium:W AndroidRuntime:E").split("\n").filter(l => /DesignYourTV|FATAL|Exception/.test(l)).slice(-15);
  console.log("      log:\n" + lc.map(l => "        " + l).join("\n"));
  // the reboot emptied the log, so the deliberate am crash is gone; anything here is a real crash
  check("no crash of dev.designyourtv since the reboot", !shell("logcat -d -b crash").includes("dev.designyourtv"));
  code = results.every(r => r.ok) ? 0 : 1;
} catch (e) {
  console.error("emu-test aborted: " + e.message);
  code = 1;
} finally {
  try { sh(ADB, ["-s", SERIAL, "emu", "kill"], { timeout: 20000 }); } catch { }
  const gone = await until(() => emu.exitCode !== null, 30000, 1000);
  if (!gone) { try { sh("taskkill.exe", ["/PID", String(emu.pid), "/T", "/F"]); } catch { } }
  console.log(`emulator ${gone ? "exited" : "stopped by PID " + emu.pid}; screenshots in ${SHOTS}`);
  console.log(`${results.filter(r => r.ok).length} of ${results.length} checks passed`);
  process.exit(code);
}
