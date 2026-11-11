// node --test hub/test/tv-power.test.mjs   (a fake adb and a fake clock; no TV, no process, no socket)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { magicPacket, parseMac, parseWakefulness, parseDeviceState, backoffDelay, step, emptyState, screenOf, checkAdbArgs,
  createTvKeeper, localAddressFor, statusLine, WAKE_CMD, KEY, DARK_READ, parseDark, darkCmd, undarkCmd, TV, FOREGROUND_CMD, A11Y, parseA11y, a11yLists } from "../lib/tv-power.mjs";
import { encodeCastMessage, decodeCastMessage, createFramer, summariseStatus } from "../lib/cast.mjs";
import { quietHub, raw, tmpDir } from "./helpers.mjs";

process.env.TV_GUARD_LOG = path.join(tmpDir(), "tv-guard.log");     // the guard logs every verdict; not into the project

// ---------- Wake-on-LAN ----------
test("wol: the magic packet is six 0xFF then the MAC sixteen times", () => {
  const p = magicPacket("02:00:00:00:00:01");
  assert.equal(p.length, 102);
  assert.deepEqual([...p.subarray(0, 6)], [255, 255, 255, 255, 255, 255]);
  for (let i = 0; i < 16; i++) assert.equal(p.subarray(6 + i * 6, 12 + i * 6).toString("hex"), "020000000001");
  assert.deepEqual(magicPacket("02-00-00-00-00-01"), p, "dashes and capitals are the same MAC");
  assert.throws(() => parseMac("02:00:00:00:00"), /bad MAC/);
  assert.throws(() => parseMac("zz:c5:99:95:78:a1"), /bad MAC/);
});

test("wol: the broadcast leaves from the address on the TV's subnet, not a VMware or Tailscale adapter", () => {
  const ifaces = {
    vmnet1: [{ family: "IPv4", address: "192.168.58.1", netmask: "255.255.255.0", internal: false }],
    tailscale: [{ family: "IPv4", address: "100.64.0.5", netmask: "255.255.255.255", internal: false }],
    wifi: [{ family: "IPv6", address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", internal: false },
      { family: "IPv4", address: "192.168.1.10", netmask: "255.255.255.0", internal: false }],
  };
  assert.equal(localAddressFor("192.168.1.20", ifaces), "192.168.1.10");
  assert.equal(localAddressFor("10.0.0.5", ifaces), null);
});

// ---------- parsing, backoff, the guard ----------
test("parse: wakefulness from dumpsys power, the TV's own line from adb devices", () => {
  assert.equal(parseWakefulness("  mWakefulness=Awake\nFailed to write while dumping service power: Broken pipe"), "Awake");
  assert.equal(parseWakefulness("mWakefulness=Asleep"), "Asleep");
  assert.equal(parseWakefulness("error: device offline"), null);
  const list = "List of devices attached\n192.168.1.20:5555\toffline\n192.168.1.11:5555\tdevice product:duchamp_global\n";
  assert.equal(parseDeviceState(list, "192.168.1.20:5555"), "offline");
  assert.equal(parseDeviceState(list, "192.168.1.99:5555"), null);
});

test("backoff: equal jitter, doubling from 2 s, capped at 60 s, never below half the window", () => {
  assert.equal(backoffDelay(0, () => 0), 1000);
  assert.equal(backoffDelay(0, () => 1), 2000);
  assert.equal(backoffDelay(3, () => 1), 16000);
  assert.equal(backoffDelay(10, () => 1), 60000);
  assert.equal(backoffDelay(50, () => 0), 30000, "a huge attempt count stays capped");
  for (let a = 0; a < 12; a++) { const d = backoffDelay(a); assert.ok(d >= 1000 && d <= 60000, `attempt ${a}: ${d}`); }
});

test("guard: only the TV's serial, only the keeper's commands", () => {
  const s = TV.serial;
  for (const ok of [["devices"], ["devices", "-l"], ["connect", s], ["disconnect", s], ["-s", s, "shell", WAKE_CMD], ["-s", s, "shell", KEY.wakeup], ["-s", s, "shell", KEY.sleep]])
    assert.deepEqual(checkAdbArgs(ok), ok);
  for (const bad of [["kill-server"], ["disconnect"], ["connect", "192.168.1.11:5555"], ["-s", "192.168.1.11:5555", "shell", WAKE_CMD],
    ["-s", s, "shell", "input keyevent 26"], ["-s", s, "shell", "pm list packages"], ["-s", s, "install", "x.apk"], ["-s", s, "reboot"], ["tcpip", "5555"]])
    assert.throws(() => checkAdbArgs(bad), /refused/, bad.join(" "));
});

// ---------- state transitions ----------
test("state: down keeps the last wakefulness, counts one outage, raises attempt; up clears it", () => {
  const t = Date.parse("2026-11-03T12:00:00Z");
  let { state: s, changed } = step(emptyState(), { reachable: true, wakefulness: "Awake" }, t);
  assert.ok(changed);
  assert.deepEqual([s.reachable, s.wakefulness, s.screen, s.attempt, s.outages, s.down_since], [true, "Awake", "on", 0, 0, null]);
  assert.equal(s.last_seen, "2026-11-03T12:00:00.000Z");

  ({ state: s, changed } = step(s, { reachable: false, error: "failed to connect (10060)", cast: { standby: true } }, t + 20e3));
  assert.ok(changed);
  assert.deepEqual([s.reachable, s.wakefulness, s.attempt, s.outages], [false, "Awake", 1, 1]);
  assert.equal(s.screen, "off", "with adb down, Cast's standby flag decides the screen");
  assert.equal(s.down_since, "2026-11-03T12:00:20.000Z");
  assert.equal(s.last_seen, "2026-11-03T12:00:00.000Z", "last_seen stays at the last good check");

  ({ state: s, changed } = step(s, { reachable: false, error: "again", cast: { standby: true } }, t + 40e3));
  assert.ok(!changed, "the same outage again is not a change");
  assert.deepEqual([s.attempt, s.outages, s.down_since], [2, 1, "2026-11-03T12:00:20.000Z"]);

  ({ state: s, changed } = step(s, { reachable: true, wakefulness: "Asleep" }, t + 60e3));
  assert.ok(changed);
  assert.deepEqual([s.reachable, s.screen, s.attempt, s.down_since, s.cast], [true, "off", 0, null, null]);
});

test("state: the screen from adb first, then Cast, else unknown", () => {
  assert.equal(screenOf({ reachable: true, wakefulness: "Dreaming" }), "on");
  assert.equal(screenOf({ reachable: true, wakefulness: "Dozing" }), "off");
  assert.equal(screenOf({ reachable: false, wakefulness: "Awake", cast: { standby: false } }), "on");
  assert.equal(screenOf({ reachable: false, wakefulness: "Awake", cast: { standby: null } }), "unknown");
  assert.match(statusLine({ ...emptyState(), reachable: true, wakefulness: "Awake", screen: "on", last_check: new Date().toISOString() }), /^TV is ON \(Awake\); adb reachable/);
  assert.match(statusLine({ ...emptyState(), screen: "off", down_since: "x", last_error: "10060", cast: { standby: true } }), /UNREACHABLE.*Cast says standby/);
});

// ---------- the keeper against a fake TV ----------
/** A fake adb: the TV is up or away; connect brings it back when `connectBrings`; keyevents change its wakefulness. */
function fakeTv({ wake = "Awake", up = true, listed = null, connectBrings = true, front = "dev.designyourtv" } = {}) {
  const f = { wake, up, listed, connectBrings, front, dark: false, brightness: 102, calls: [], a11yBound: true, a11yCrashed: false, a11yList: A11Y.service, healWorks: true };
  f.run = async (exe, args) => {
    checkAdbArgs(args);                                       // the keeper must never hand run() anything else
    f.calls.push(args.join(" "));
    if (args[0] === "devices") return { out: `List of devices attached\n${f.up ? `${TV.serial}\tdevice\n` : f.listed ? `${TV.serial}\t${f.listed}\n` : ""}192.168.1.11:5555\tdevice\n` };
    if (args[0] === "disconnect") { f.listed = null; return { out: `disconnected ${TV.serial}` }; }
    if (args[0] === "connect") { if (f.connectBrings) f.up = true; return { out: f.up ? `connected to ${TV.serial}` : `failed to connect to '${TV.serial}': (10060)` }; }
    if (!f.up) return { code: 1, out: "", err: f.listed ? "error: device offline" : `error: device '${TV.serial}' not found` };
    if (args[3] === FOREGROUND_CMD) return { out: `mWakefulness=${f.wake}
  mResumedActivity: ActivityRecord{1a u0 ${f.front}/.Main t1}
  mFocusedApp=ActivityRecord{2b u0 ${f.front}/.Main t1}
` };
    if (args[3] === A11Y.read) return { out: `     Bound services:{${f.a11yBound ? "Service[label=designyourtv Home button, feedbackType[FEEDBACK_GENERIC]]" : ""}}
     Crashed services:{${f.a11yCrashed ? "{dev.designyourtv/dev.designyourtv.HomeKeyService}" : ""}}]
` };
    if (args[3] === A11Y.list) return { out: `${f.a11yList}
` };
    if (/^settings put secure enabled_accessibility_services /.test(args[3])) {
      f.a11yList = args[3].split(" ").pop();
      if (f.a11yList.includes("HomeKeyService") && f.healWorks) { f.a11yBound = true; f.a11yCrashed = false; } else f.a11yBound = false;
      return { out: "" };
    }
    if (args[3] === "settings put secure accessibility_enabled 1") return { out: "" };
    if (args[3] === WAKE_CMD) return { out: `  mWakefulness=${f.wake}\n`, err: "Failed to write while dumping service power: Broken pipe" };
    if (args[3] === DARK_READ) return { out: `${f.brightness}\n${f.dark ? 0 : 1}\n` };
    if (/^settings put (system screen_brightness|global (power_picture_off|screen_off_control)) /.test(args[3])) {
      for (const part of args[3].split("; ")) {
        const [, , , key, val] = part.split(" ");
        if (key === "screen_off_control") f.dark = val === "0";
        if (key === "screen_brightness") f.brightness = Number(val);
      }
      return { out: "" };
    }
    if (args[3] === KEY.wakeup) { f.wake = "Awake"; return { out: "" }; }
    if (args[3] === KEY.sleep) { f.wake = "Asleep"; return { out: "" }; }
    throw new Error("unexpected");
  };
  return f;
}
const fakeClock = () => { let t = Date.parse("2026-11-03T12:00:00Z"); return { now: () => t, sleep: async ms => { t += ms; } }; };
const noCast = { status: async () => { throw new Error("cast: ECONNREFUSED"); }, launch: async () => { throw new Error("cast: ECONNREFUSED"); }, stop: async () => ({}) };

test("keeper: an offline TV is disconnected by its serial, reconnected, and recorded to the state file", async () => {
  const f = fakeTv({ up: false, listed: "offline" }), dir = tmpDir("tv"), file = path.join(dir, "tv.json"), changes = [];
  const k = createTvKeeper({ run: f.run, stateFile: file, cast: noCast, onChange: s => changes.push(s), ...fakeClock() });
  const s = await k.check();
  assert.deepEqual([s.reachable, s.wakefulness], [true, "Awake"]);
  assert.deepEqual(f.calls.filter(c => !c.startsWith("-s")), ["devices", `disconnect ${TV.serial}`, `connect ${TV.serial}`]);
  assert.ok(f.calls.every(c => !c.includes("192.168.1.11")), "the mirror is never touched");
  assert.equal(changes.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).wakefulness, "Awake");
});

test("keeper: a TV that stays away is unreachable, asks Cast, and keeps last_seen", async () => {
  const f = fakeTv({ up: false, connectBrings: false });
  const k = createTvKeeper({ run: f.run, cast: { ...noCast, status: async () => ({ standby: true, active_input: false, apps: [] }) }, ...fakeClock() });
  const s = await k.check();
  assert.deepEqual([s.reachable, s.screen, s.attempt, s.cast.standby], [false, "off", 1, true]);
  assert.match(s.last_error, /failed to connect/);
});

test("keeper: a TV whose adb stays silent is not reconnected on every check (7 Nov: ~240 reconnects in a day)", async () => {
  const f = fakeTv({ up: false, connectBrings: false });
  let casts = 0;
  const clock = fakeClock();
  const k = createTvKeeper({ run: f.run, cast: { ...noCast, status: async () => { casts++; return { standby: true, active_input: false, apps: [] }; } }, ...clock });
  const connects = () => f.calls.filter(c => c === `connect ${TV.serial}`).length;
  await k.check();
  assert.equal(connects(), 1, "the first failed check reconnects once");
  // 60 checks, one a minute, for the next hour: the backoff (60 s doubling to 15 min) allows only a handful of reconnects
  for (let i = 0; i < 60; i++) { await clock.sleep(60e3); await k.check(); }
  assert.ok(connects() <= 8, `reconnects in an hour: ${connects()}`);
  assert.ok(casts <= 8, `cast probes in an hour: ${casts}`);
  assert.ok(f.calls.every(c => !c.startsWith("disconnect")), "never disconnects a TV that is not listed offline");
  // when it comes back the gate opens at once and the next outage reconnects straight away
  f.up = true;
  const s = await k.check();
  assert.equal(s.reachable, true);
  f.up = false; f.connectBrings = false;
  const before = connects();
  await k.check();
  assert.equal(connects(), before + 1, "a fresh outage reconnects on its first check");
});

test("keeper: an explicit power-on is never held back by the reconnect backoff", async () => {
  const f = fakeTv({ up: false, connectBrings: false });
  const clock = fakeClock();
  const k = createTvKeeper({ run: f.run, cast: noCast, probe: async () => true, wol: async () => ({ sent: 1, from: "x" }), ...clock });
  await k.check();                                           // arms the backoff
  f.connectBrings = true;
  const r = await k.power("on", { wolWaitMs: 5e3, cast: false });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("power off --deep: KEYCODE_SLEEP, then it reads Asleep; off again is a no-op", async () => {
  const f = fakeTv({ wake: "Awake" });
  const k = createTvKeeper({ run: f.run, cast: noCast, ...fakeClock() });
  const r = await k.power("off", { deep: true });
  assert.deepEqual([r.ok, r.via, r.wakefulness], [true, "adb", "Asleep"]);
  assert.ok(f.calls.includes(`-s ${TV.serial} shell ${KEY.sleep}`));
  const again = await k.power("off", { deep: true });
  assert.deepEqual([again.ok, again.result], [true, "already off"]);
  assert.equal(f.calls.filter(c => c.endsWith(KEY.sleep)).length, 1, "no second sleep key");
  assert.equal(k.snapshot().last_power.action, "off");
});

test("power on: adb answers, so KEYCODE_WAKEUP and no Wake-on-LAN", async () => {
  const f = fakeTv({ wake: "Asleep" });
  let wols = 0;
  const k = createTvKeeper({ run: f.run, cast: noCast, wol: async () => { wols++; return { sent: 12, from: "x" }; }, ...fakeClock() });
  const r = await k.power("on");
  assert.deepEqual([r.ok, r.via, r.wakefulness, wols], [true, "adb", "Awake", 0]);
  assert.deepEqual((await k.power("on")).result, "already on");
});

test("power on: adb away, Wake-on-LAN brings the port back, reconnect, then KEYCODE_WAKEUP", async () => {
  const f = fakeTv({ wake: "Asleep", up: false, connectBrings: false });
  let wols = 0, launches = 0;
  const probe = async () => wols > 0;                          // the adb port answers once a magic packet has gone
  const k = createTvKeeper({ run: f.run, probe, wol: async () => { wols++; f.connectBrings = true; return { sent: 12, from: "192.168.1.10" }; },
    cast: { ...noCast, launch: async () => { launches++; throw new Error("no"); } }, ...fakeClock() });
  const r = await k.power("on");
  assert.deepEqual([r.ok, r.via, launches], [true, "wol", 0]);
  assert.equal(f.wake, "Awake");
  assert.ok(r.steps.includes("wake-on-lan") && r.steps.includes("adb wakeup"), r.steps.join(", "));
});

test("power on: nothing answers; Cast is tried last and its splash stopped; --no-cast skips it", async () => {
  const f = fakeTv({ up: false, connectBrings: false });
  const log = [];
  const cast = { status: async () => ({ standby: true, apps: [] }), launch: async () => { log.push("launch"); return { apps: [{ name: "Default Media Receiver", sessionId: "s1" }] }; },
    stop: async (ip, id) => { log.push(`stop ${id}`); return {}; } };
  const k = createTvKeeper({ run: f.run, probe: async () => false, wol: async () => ({ sent: 12, from: "x" }), cast, ...fakeClock() });
  const r = await k.power("on");
  assert.equal(r.ok, false);
  assert.deepEqual(log, ["launch", "stop s1"], "the splash is stopped even when the TV never came back");
  const r2 = await k.power("on", { cast: false });
  assert.equal(r2.ok, false);
  assert.match(r2.result, /Cast not tried/);
  assert.equal(log.length, 2);
});

test("power on --cast-only: only the Cast LAUNCH, no 224, so a pass proves Cast woke it", async () => {
  const f = fakeTv({ wake: "Asleep" });
  const seen = [];
  const cast = { status: async () => ({ standby: false, apps: [] }), stop: async () => { seen.push("stop"); return {}; },
    launch: async () => { seen.push("launch"); f.wake = "Awake"; return { apps: [{ name: "Default Media Receiver", sessionId: "s9" }] }; } };
  const k = createTvKeeper({ run: f.run, probe: async () => true, wol: async () => { seen.push("wol"); return { sent: 0, from: "x" }; }, cast, ...fakeClock() });
  const r = await k.power("on", { castOnly: true });
  assert.deepEqual([r.ok, r.via], [true, "cast"]);
  assert.deepEqual(seen, ["launch", "stop"], "no Wake-on-LAN; the splash is stopped");
  assert.ok(!f.calls.some(c => c.endsWith(KEY.wakeup)), "no KEYCODE_WAKEUP was sent");
});

test("power: one command at a time; a bad action is refused", async () => {
  const f = fakeTv({ wake: "Awake" });
  const k = createTvKeeper({ run: f.run, cast: noCast });
  const [a, b] = await Promise.all([k.power("off"), k.power("on")]);
  assert.equal(a.ok, true);
  assert.deepEqual([b.ok, b.busy], [false, true]);
  assert.equal((await k.power("reboot")).ok, false);
});

test("tv-guard: a power-off while YouTube is in front is refused, and no sleep key is sent", async () => {
  const f = fakeTv({ wake: "Awake", front: "com.google.android.youtube.tv" });
  const k = createTvKeeper({ run: f.run, cast: noCast, ...fakeClock() });
  const r = await k.power("off", { deep: true });
  assert.equal(r.ok, false);
  assert.match(r.result, /TV GUARD refused sleep.*youtube/);
  assert.ok(!f.calls.some(c => c.endsWith(KEY.sleep)), "the sleep key never left");
  assert.equal(f.wake, "Awake");
});

test("tv-guard: the owner's explicit power-off goes through over another app; a wake over a sleeping TV needs no foreground", async () => {
  const f = fakeTv({ wake: "Awake", front: "com.netflix.ninja" });
  const k = createTvKeeper({ run: f.run, cast: noCast, ...fakeClock() });
  const r = await k.power("off", { explicit: true, deep: true });
  assert.deepEqual([r.ok, r.wakefulness], [true, "Asleep"]);
  const on = await k.power("on");
  assert.equal(on.ok, true, "asleep: the wake key is allowed whatever was last in front");
  assert.ok(f.calls.some(c => c.endsWith(KEY.wakeup)));
});

test("tv-guard: an unreadable foreground refuses the sleep key (fail-closed)", async () => {
  const f = fakeTv({ wake: "Awake" });
  const k = createTvKeeper({ run: async (exe, args) => (args[3] === FOREGROUND_CMD ? { code: 1, out: "", err: "boom" } : f.run(exe, args)), cast: noCast, ...fakeClock() });
  const r = await k.power("off", { deep: true });
  assert.equal(r.ok, false); assert.match(r.result, /fail-closed/);
});

// ---------- "off" is dark but awake (6 Nov: a deep sleep drops the network and nothing wakes it) ----------
test("dark: parse and commands", () => {
  assert.deepEqual(parseDark(["102", "1", ""].join("\n")), { dark: false, brightness: 102 });
  assert.deepEqual(parseDark(["0", "0"].join("\n")), { dark: true, brightness: 0 });
  assert.deepEqual(parseDark(["null", "null"].join("\n")), { dark: false, brightness: null });
  assert.match(darkCmd(), /screen_off_control 0/);
  assert.match(undarkCmd(77), /screen_brightness 77$/);
  assert.match(undarkCmd(0), /screen_brightness 102$/, "a lost brightness falls back to 102");
  for (const c of [darkCmd(), undarkCmd(60), DARK_READ]) assert.doesNotThrow(() => checkAdbArgs(["-s", TV.serial, "shell", c]), c);
  assert.throws(() => checkAdbArgs(["-s", TV.serial, "shell", "settings put system screen_brightness 5; reboot"]));
});

test("power off (default) darkens and stays awake and reachable; on brings the picture and its brightness back; the watcher follows", async () => {
  const f = fakeTv({ wake: "Awake" }); f.brightness = 77;
  const watch = []; const k = createTvKeeper({ run: f.run, cast: noCast, watcher: { start: () => watch.push("start"), stop: () => watch.push("stop") }, ...fakeClock() });
  const r = await k.power("off");
  assert.deepEqual([r.ok, r.via, r.wakefulness, r.screen], [true, "adb", "Awake", "off"]);
  assert.equal(f.dark, true); assert.equal(f.brightness, 0); assert.equal(f.wake, "Awake");
  assert.ok(!f.calls.some(c => c.endsWith(KEY.sleep)), "no sleep key: the network must stay up");
  assert.equal(k.snapshot().screen, "off");
  const again = await k.power("on");
  assert.deepEqual([again.ok, again.via], [true, "adb"]);
  assert.equal(f.dark, false); assert.equal(f.brightness, 77, "the brightness he had comes back");
  assert.deepEqual(watch, ["start", "stop"]);
  assert.equal((await k.power("on")).result, "already on");
});

test("power off (dark): refused over another app unless it is the owner's explicit off", async () => {
  const f = fakeTv({ wake: "Awake", front: "com.google.android.youtube.tv" });
  const k = createTvKeeper({ run: f.run, cast: noCast, ...fakeClock() });
  const r = await k.power("off");
  assert.equal(r.ok, false); assert.match(r.result, /TV GUARD refused dark.*youtube/);
  assert.equal(f.dark, false);
  assert.equal((await k.power("off", { explicit: true })).ok, true);
  assert.equal(f.dark, true);
});

test("power on from a deep sleep also lifts the dark flag", async () => {
  const f = fakeTv({ wake: "Awake" });
  const k = createTvKeeper({ run: f.run, cast: noCast, ...fakeClock() });
  await k.power("off"); await k.power("off", { deep: true });
  assert.equal(f.wake, "Asleep");
  const r = await k.power("on");
  assert.equal(r.ok, true); assert.equal(f.dark, false);
});

// ---------- HomeKeyService healing ----------
test("a11y: parse a bound service, an unbound one and a crashed one (dumpsys accessibility, recorded 6 Nov)", () => {
  const bound = "     Bound services:{Service[label=designyourtv Home button, feedbackType[FEEDBACK_GENERIC], capabilities=8]}\n     Crashed services:{}]";
  const dead = "     Bound services:{}\n     Crashed services:{{dev.designyourtv/dev.designyourtv.HomeKeyService}}]";
  assert.deepEqual(parseA11y(bound), { bound: true, crashed: false });
  assert.deepEqual(parseA11y(dead), { bound: false, crashed: true });
  assert.deepEqual(parseA11y("Bound services:{Service[label=Some other service]}\nCrashed services:{}"), { bound: false, crashed: false });
  assert.deepEqual(parseA11y(""), { bound: false, crashed: false });
});

test("a11y: the toggle keeps other enabled services and never lists ours twice", () => {
  assert.deepEqual(a11yLists("dev.designyourtv/.HomeKeyService"), { without: "null", withOurs: A11Y.service });
  assert.deepEqual(a11yLists("null"), { without: "null", withOurs: A11Y.service });
  assert.deepEqual(a11yLists("a/.X:dev.designyourtv/.HomeKeyService:b/.Y"), { without: "a/.X:b/.Y", withOurs: `a/.X:b/.Y:${A11Y.service}` });
  assert.equal(a11yLists("dev.designyourtv/dev.designyourtv.HomeKeyService").without, "null", "the long component form is ours too");
});

test("a11y: awake with the service dead, the keeper toggles it and records the heal", async () => {
  const f = fakeTv({ wake: "Awake" }); f.a11yBound = false; f.a11yCrashed = true;
  const logs = [], k = createTvKeeper({ run: f.run, cast: noCast, a11yHeal: true, log: (l, m) => logs.push([l, m]), ...fakeClock() });
  const s = await k.check();
  assert.equal(f.a11yBound, true);
  assert.equal(s.a11y.heals, 1); assert.equal(s.a11y.bound, true);
  assert.ok(logs.some(([l, m]) => l === "warn" && /was crashed; toggled it, now bound/.test(m)), JSON.stringify(logs));
  assert.deepEqual(f.calls.filter(c => c.includes("enabled_accessibility_services ")).map(c => c.split(" ").pop()), ["null", A11Y.service]);
});

test("a11y: a bound service is left alone, and a check runs at most once a minute", async () => {
  const f = fakeTv({ wake: "Awake" });
  const clock = fakeClock(), k = createTvKeeper({ run: f.run, cast: noCast, a11yHeal: true, ...clock });
  await k.check(); await k.check();
  assert.equal(f.calls.filter(c => c.endsWith(A11Y.read)).length, 1, "the second check is inside the minute");
  assert.ok(!f.calls.some(c => c.includes("settings put")), "nothing was written");
  await clock.sleep(61e3); await k.check();
  assert.equal(f.calls.filter(c => c.endsWith(A11Y.read)).length, 2);
});

test("a11y: asleep, or with heal off, nothing is asked", async () => {
  const asleep = fakeTv({ wake: "Asleep" }); asleep.a11yBound = false;
  await createTvKeeper({ run: asleep.run, cast: noCast, a11yHeal: true, ...fakeClock() }).check();
  assert.ok(!asleep.calls.some(c => c.includes("accessibility")));
  const off = fakeTv({ wake: "Awake" }); off.a11yBound = false;
  await createTvKeeper({ run: off.run, cast: noCast, ...fakeClock() }).check();
  assert.ok(!off.calls.some(c => c.includes("accessibility")), "off unless the hub asks for it");
});

test("a11y: a wake is checked at once, inside the minute; a heal that does not take is logged as an error", async () => {
  const f = fakeTv({ wake: "Asleep" }); f.healWorks = false;
  const logs = [], clock = fakeClock(), k = createTvKeeper({ run: f.run, cast: noCast, a11yHeal: true, log: (l, m) => logs.push([l, m]), ...clock });
  await k.check();                                   // asleep: nothing
  f.wake = "Awake"; f.a11yBound = false;
  await k.check();                                   // the Asleep -> Awake step: checked immediately
  assert.ok(logs.some(([l, m]) => l === "error" && /STILL unbound/.test(m)), JSON.stringify(logs));
});

// ---------- Cast v2 framing ----------
test("cast: a CastMessage round-trips and the framer splits a stream at any byte", () => {
  const a = encodeCastMessage({ namespace: "urn:x-cast:com.google.cast.receiver", data: { type: "GET_STATUS", requestId: 7 } });
  const b = encodeCastMessage({ source: "receiver-0", destination: "sender-0", namespace: "urn:x-cast:com.google.cast.tp.heartbeat", data: { type: "PING" } });
  const m = decodeCastMessage(a.subarray(4));
  assert.deepEqual([m.source, m.destination, m.namespace, JSON.parse(m.payload).requestId], ["sender-0", "receiver-0", "urn:x-cast:com.google.cast.receiver", 7]);
  const feed = createFramer(), all = Buffer.concat([a, b]), got = [];
  for (let i = 0; i < all.length; i += 5) got.push(...feed(all.subarray(i, i + 5)));
  assert.deepEqual(got.map(x => JSON.parse(x.payload).type), ["GET_STATUS", "PING"]);
});

test("cast: RECEIVER_STATUS (recorded off the Bedroom TV, 3 Nov) summarised", () => {
  const rec = { requestId: 1, type: "RECEIVER_STATUS", status: { applications: [{ appId: "2C6A6E3D", appType: "ANDROID_TV", displayName: "YouTube", isIdleScreen: false,
    sessionId: "a6311b68", statusText: "YouTube" }], isActiveInput: true, isStandBy: false, volume: { controlType: "master", level: 0.36, muted: false } } };
  assert.deepEqual(summariseStatus(rec), { apps: [{ appId: "2C6A6E3D", name: "YouTube", sessionId: "a6311b68", idle: false }], standby: false, active_input: true, volume: { level: 0.36, muted: false } });
  assert.deepEqual(summariseStatus({}).standby, null);
});

// ---------- the hub routes ----------
test("hub: /api/tv/status and POST /api/tv/power use the keeper; a hub without one says 503", async () => {
  const none = await quietHub();
  try { assert.equal((await raw(none.port, "/api/tv/status")).status, 503); } finally { await none.close(); }
  const calls = [];
  const tv = { snapshot: () => ({ reachable: true, wakefulness: "Awake", screen: "on" }), refresh: async () => ({ reachable: true, fresh: true }),
    power: async (action, o) => { calls.push([action, o.cast]); return action === "on" ? { ok: true, action, result: "already on" } : { ok: false, action, result: "adb unreachable" }; }, stop() {} };
  const hub = await quietHub({ tv });
  const post = body => raw(hub.port, "/api/tv/power", { method: "POST", headers: { "content-type": "application/json" }, body });
  try {
    assert.equal(JSON.parse((await raw(hub.port, "/api/tv/status")).body).screen, "on");
    assert.equal(JSON.parse((await raw(hub.port, "/api/tv/status?fresh=1")).body).fresh, true);
    const on = await post({ action: "on" });
    assert.deepEqual([on.status, JSON.parse(on.body).result], [200, "already on"]);
    assert.equal((await post({ action: "off", cast: false })).status, 502, "a command that did not work is a 502 with its reason");
    assert.equal((await post({ action: "reboot" })).status, 400);
    assert.deepEqual(calls, [["on", true], ["off", false]]);
  } finally { await hub.close(); }
});
