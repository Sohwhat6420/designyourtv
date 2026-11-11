// node --test tools/test/tv-guard.test.mjs   (a fake adb and a fixed clock; no TV, no process, no socket)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseForeground, classifyShell, classifyShellLine, classifyAdb, decide, check, guardedAdb, requireOk, inEvening, sgtHour,
  eveningAllowed, isOurs, FOREGROUND_CMD } from "../tv-guard.mjs";

process.env.TV_GUARD_LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tvguard-")), "guard.log");

const DAY = Date.parse("2026-11-06T04:00:00Z");      // 12:00 SGT
const EVE = Date.parse("2026-11-06T12:03:00Z");      // 20:03 SGT: the minute the 4 Nov lane force-stopped YouTube
const NIGHT = Date.parse("2026-11-06T16:30:00Z");    // 00:30 SGT, still inside the gate
const OPEN = Date.parse("2026-11-06T17:00:00Z");     // 01:00 SGT, the gate is over

const dump = (wake, resumed, focused = resumed) => `mWakefulness=${wake}\n  mResumedActivity: ActivityRecord{1a2b3c u0 ${resumed}/.Main t12}\n  mFocusedApp=ActivityRecord{4d5e6f u0 ${focused}/.Main t12}\n`;
const YT = dump("Awake", "com.google.android.youtube.tv");
const OURS = dump("Awake", "dev.designyourtv");
const LAUNCHER = dump("Awake", "com.google.android.apps.tv.launcherx");
const fakeRun = (text, seen = []) => async (exe, args) => { seen.push(args); return { code: 0, out: text, err: "" }; };

test("parse: wakefulness, resumed and focused packages; a literal null is not a package", () => {
  const p = parseForeground(YT);
  assert.equal(p.wakefulness, "Awake"); assert.equal(p.resumed, "com.google.android.youtube.tv"); assert.deepEqual(p.packages, ["com.google.android.youtube.tv"]);
  const mixed = parseForeground(dump("Awake", "dev.designyourtv", "com.netflix.ninja"));
  assert.deepEqual(mixed.packages.sort(), ["com.netflix.ninja", "dev.designyourtv"]);
  const asleep = parseForeground("mWakefulness=Asleep\n  mResumedActivity: null\n");
  assert.equal(asleep.wakefulness, "Asleep"); assert.deepEqual(asleep.packages, []);
  assert.deepEqual(parseForeground("error: device offline").packages, []);
});

test("classify: every action the 4 Nov lane took on the TV is a guarded kind", () => {
  assert.equal(classifyShell("input keyevent 3").kind, "home");
  assert.equal(classifyShell("input keyevent KEYCODE_HOME").kind, "home");
  assert.equal(classifyShell("input keyevent KEYCODE_CHANNEL_UP").kind, "input");
  assert.equal(classifyShell("input keyevent 224").kind, "wake");
  assert.equal(classifyShell("input keyevent 223").kind, "sleep");
  assert.equal(classifyShell("input tap 100 100").kind, "input");
  assert.equal(classifyShell("am start -W -n dev.designyourtv/.HomeActivity").kind, "launch");
  assert.deepEqual(classifyShell("am force-stop com.google.android.youtube.tv"), { kind: "stop", pkg: "com.google.android.youtube.tv" });
  assert.equal(classifyShell("monkey -p x 1").kind, "launch");
  assert.equal(classifyShell("pm uninstall dev.designyourtv").kind, "install");
  assert.equal(classifyShell("wm size 3840x2160").kind, "display");
  assert.equal(classifyShell("settings put system screen_brightness 0").kind, "brightness");
  assert.equal(classifyShell("settings put global picture_backlight 20").kind, "brightness");
  assert.equal(classifyShell("settings put system screen_off_timeout 600000").kind, "setting");
  assert.equal(classifyShell("rm -rf /sdcard/x").kind, "unknown", "anything not recognised is guarded");
});

test("classify: read-only commands are never gated", () => {
  for (const c of ["dumpsys power", "settings get system screen_off_timeout", "getprop ro.build.version.sdk", "pm list packages", "cat /proc/net/unix", "screencap -p", "wm size"])
    assert.equal(classifyShell(c).kind, "read", c);
  assert.equal(classifyAdb(["-s", "x:5555", "shell", "dumpsys activity | grep mResumed"]).kind, "read");
  assert.equal(classifyAdb(["-s", "x:5555", "exec-out", "screencap", "-p"]).kind, "read");
  assert.equal(classifyAdb(["devices", "-l"]).kind, "read");
});

test("classify: a chain takes its most restrictive part; a read piped into a stop is a stop", () => {
  assert.equal(classifyShellLine("dumpsys power; input keyevent 3").kind, "home");
  assert.equal(classifyShellLine("settings put system screen_off_timeout 1; am force-stop com.netflix.ninja").kind, "stop");
  assert.equal(classifyShellLine("dumpsys activity | grep -E mResumed").kind, "read");
});

test("classify: adb verbs that are never run against the TV", () => {
  for (const v of ["kill-server", "start-server", "tcpip", "root", "pair", "reconnect"]) assert.ok(classifyAdb([v]).refuse, v);
  assert.equal(classifyAdb(["-s", "x:5555", "install", "a.apk"]).kind, "install");
  assert.equal(classifyAdb(["-s", "x:5555", "install-multiple", "a.apk", "b.apk"]).kind, "install");
});

test("decide: THE 4 NOV SCENARIO. With YouTube in front, none of what the lane did is allowed (in daylight too)", () => {
  const yt = parseForeground(YT), o = { now: DAY };
  for (const kind of ["home", "launch", "input", "install", "reload", "display", "brightness", "sleep", "unknown"])
    assert.equal(decide(kind, yt, o).ok, false, `${kind} over YouTube`);
  assert.equal(decide("stop", yt, { ...o, pkg: "com.google.android.youtube.tv" }).ok, false);
  assert.match(decide("home", yt, o).reason, /youtube/);
});

test("decide: with our app or launcherx in front, daylight actions go ahead (positive control)", () => {
  for (const d of [OURS, LAUNCHER]) {
    const fg = parseForeground(d);
    for (const kind of ["home", "launch", "input", "reload", "install", "brightness", "sleep"]) assert.equal(decide(kind, fg, { now: DAY }).ok, true, kind);
  }
  assert.equal(decide("stop", parseForeground(OURS), { now: DAY, pkg: "dev.designyourtv" }).ok, true, "our own app may be stopped");
});

test("decide: force-stop of any other app is refused even when ours is in front; launcherx is not stoppable either", () => {
  const ours = parseForeground(OURS);
  assert.equal(decide("stop", ours, { now: DAY, pkg: "com.google.android.youtube.tv" }).ok, false);
  assert.equal(decide("stop", ours, { now: DAY, pkg: "com.google.android.apps.tv.launcherx" }).ok, false);
  assert.equal(decide("stop", ours, { now: DAY, pkg: null }).ok, false, "am kill-all has no package");
});

test("decide: a mixed foreground (resumed ours, focused another app) counts as another app", () => {
  const fg = parseForeground(dump("Awake", "dev.designyourtv", "com.netflix.ninja"));
  assert.equal(decide("input", fg, { now: DAY }).ok, false);
});

test("decide: fails closed when the foreground cannot be read or parsed", () => {
  assert.equal(decide("input", null, { now: DAY }).ok, false);
  assert.match(decide("input", null, { now: DAY }).reason, /fail-closed/);
  assert.equal(decide("input", parseForeground("mWakefulness=Awake\n"), { now: DAY }).ok, false, "awake but no resumed activity parsed");
});

test("decide: wake fails open and is allowed while asleep; settings and reads are never gated", () => {
  assert.equal(decide("wake", null, { now: DAY }).ok, true);
  assert.equal(decide("wake", parseForeground("mWakefulness=Asleep\n"), { now: EVE }).ok, true);
  assert.equal(decide("wake", parseForeground(YT), { now: DAY }).ok, false, "a wake key over a foreign app is not needed and is refused");
  assert.equal(decide("setting", null, { now: EVE }).ok, true);
  assert.equal(decide("read", null, { now: EVE }).ok, true);
});

test("decide: an asleep TV refuses every non-wake screen action (a lane must not wake it)", () => {
  assert.equal(decide("launch", parseForeground("mWakefulness=Asleep\n"), { now: DAY }).ok, false);
});

test("decide: the explicit-user power-off passes over a foreign app, and nothing else does", () => {
  const yt = parseForeground(YT);
  assert.equal(decide("sleep", yt, { now: DAY, explicit: true }).ok, true);
  assert.equal(decide("sleep", yt, { now: DAY }).ok, false);
  assert.equal(decide("home", yt, { now: DAY, explicit: true }).ok, false);
});

test("time gate: 18:00 to 01:00 SGT refuses even our own app in front, unless he allowed it", () => {
  assert.equal(sgtHour(EVE), 20); assert.equal(sgtHour(DAY), 12);
  assert.equal(inEvening(EVE), true); assert.equal(inEvening(NIGHT), true); assert.equal(inEvening(OPEN), false); assert.equal(inEvening(DAY), false);
  const ours = parseForeground(OURS);
  assert.equal(decide("input", ours, { now: EVE, allowEvening: false }).ok, false);
  assert.match(decide("input", ours, { now: EVE, allowEvening: false }).reason, /time gate/);
  assert.equal(decide("input", ours, { now: NIGHT, allowEvening: false }).ok, false);
  assert.equal(decide("input", ours, { now: EVE, allowEvening: true }).ok, true);
  assert.equal(decide("input", ours, { now: OPEN, allowEvening: false }).ok, true);
  assert.equal(decide("input", ours, { now: EVE, allowEvening: false, gate: "none" }).ok, true, "the hub's power commands come from the person in the room, not a script");
});

test("time gate: the allow file lifts it only until its expiry, and the env switch lifts it", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tvallow-")), "allow.json");
  assert.equal(eveningAllowed(EVE, f, {}), false, "no file");
  fs.writeFileSync(f, JSON.stringify({ evening_until: "2026-11-06T14:00:00Z" }));
  assert.equal(eveningAllowed(EVE, f, {}), true);
  assert.equal(eveningAllowed(Date.parse("2026-11-06T15:00:00Z"), f, {}), false, "expired");
  fs.writeFileSync(f, "{not json");
  assert.equal(eveningAllowed(EVE, f, {}), false, "garbage is a no");
  assert.equal(eveningAllowed(EVE, f, { TV_GUARD_ALLOW_EVENING: "1" }), true);
});

test("check: asks the TV with the right command and logs the verdict; an adb failure is a refusal", async () => {
  const seen = [];
  const yes = await check({ kind: "input", who: "t-ours", run: fakeRun(OURS, seen), now: DAY, allowEvening: true });
  assert.equal(yes.ok, true);
  assert.deepEqual(seen[0].slice(2), ["shell", FOREGROUND_CMD]);
  const no = await check({ kind: "home", who: "t-yt", run: fakeRun(YT), now: DAY });
  assert.equal(no.ok, false);
  const broke = await check({ kind: "home", who: "t-down", run: async () => { throw new Error("adb timed out"); }, now: DAY });
  assert.equal(broke.ok, false); assert.match(broke.reason, /fail-closed/);
  const log = fs.readFileSync(process.env.TV_GUARD_LOG, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(log.map(l => [l.who, l.ok]), [["t-ours", true], ["t-yt", false], ["t-down", false]]);
});

test("check: reads and settings never even ask the TV", async () => {
  const seen = [];
  assert.equal((await check({ kind: "read", run: fakeRun(YT, seen) })).ok, true);
  assert.equal((await check({ kind: "setting", run: fakeRun(YT, seen) })).ok, true);
  assert.equal(seen.length, 0);
});

test("guardedAdb: runs a guarded command only when allowed; the command text never reaches adb when refused", async () => {
  const seen = [];
  const run = async (exe, args) => { seen.push(args); return { code: 0, out: args.join(" ").includes("mResumedActivity") ? YT : "", err: "" }; };
  await assert.rejects(guardedAdb(["-s", "x:5555", "shell", "am force-stop com.google.android.youtube.tv"], { run, now: DAY, who: "t" }), /TV GUARD refused stop/);
  await assert.rejects(guardedAdb(["shell", "input keyevent 3"], { run, now: DAY, who: "t" }), /TV GUARD refused home/);
  await assert.rejects(guardedAdb(["kill-server"], { run, who: "t" }), /never run against the TV/);
  assert.ok(seen.every(a => !a.some(x => /force-stop|keyevent 3/.test(x))), "no refused command was sent");
  const r = await guardedAdb(["shell", "dumpsys power"], { run, who: "t" });
  assert.equal(r.code, 0);
  assert.deepEqual(seen.at(-1).slice(0, 2), ["-s", "192.168.1.20:5555"], "the TV's serial is added when the caller gave none");
});

test("requireOk: throws an error that starts with the lane-visible marker", async () => {
  await assert.rejects(requireOk({ kind: "reload", run: fakeRun(YT), now: DAY, who: "t" }), e => /^⛔ TV GUARD refused reload/.test(e.message) && e.guard.ok === false);
  assert.equal((await requireOk({ kind: "reload", run: fakeRun(OURS), now: DAY, who: "t" })).ok, true);
});

test("ours: exactly our app and launcherx", () => {
  assert.equal(isOurs("dev.designyourtv"), true); assert.equal(isOurs("com.google.android.apps.tv.launcherx"), true);
  assert.equal(isOurs("com.google.android.youtube.tv"), false); assert.equal(isOurs(null), false);
});
