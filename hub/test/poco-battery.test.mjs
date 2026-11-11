// node --test hub/test/poco-battery.test.mjs   (recorded `dumpsys battery` text; no phone, no adb, no network)
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseBattery, step, isPoco, isS24, assertPoco, createPocoBattery, createNtfyPush, COOLDOWN_MS } from "../poco-battery.mjs";

// the example phones (read lazily, at each call): a reminder phone and a read-only one
process.env.TV_PHONES_FILE = fileURLToPath(new URL("./fixtures/phones.json", import.meta.url));

// recorded shape of a HyperOS (Android 14) `dumpsys battery`, values swapped per test
const DUMP = ({ level = 64, status = 3, ac = false, usb = false, wireless = false, temp = 312, extra = "" } = {}) => `Current Battery Service state:
  AC powered: ${ac}
  USB powered: ${usb}
  Wireless powered: ${wireless}
  Dock powered: false
  Max charging current: 500000
  Max charging voltage: 5000000
  Charge counter: 2881000
  status: ${status}
  health: 2
  present: true
  level: ${level}
  scale: 100
  voltage: 3912
  temperature: ${temp}
  technology: Li-poly
${extra}`;
const DEVICES = `List of devices attached
192.168.1.78:40881    device product:duchamp_global model:2311DRK48G device:duchamp transport_id:49
adb-R5TEST00000-abc123._adb-tls-connect._tcp device product:e3qxxx model:SM_S928B device:e3q transport_id:50
`;
const S24_ONLY = `List of devices attached
adb-R5TEST00000-abc123._adb-tls-connect._tcp device product:e3qxxx model:SM_S928B device:e3q transport_id:50
`;

test("parse: level, status, temperature in tenths, plugged type", () => {
  assert.deepEqual(parseBattery(DUMP()), { level: 64, scale: 100, pct: 64, status: 3, status_name: "discharging", charging: false, plugged: "none", temp_c: 31.2 });
  const c = parseBattery(DUMP({ level: 91, status: 2, usb: true }));
  assert.deepEqual([c.charging, c.plugged, c.status_name], [true, "usb", "charging"]);
  const f = parseBattery(DUMP({ level: 100, status: 5, ac: true }));
  assert.deepEqual([f.charging, f.plugged, f.status_name], [true, "ac", "full"], "full on the charger counts as charging");
  assert.equal(parseBattery(DUMP({ status: 3, wireless: true })).plugged, "wireless");
  assert.equal(parseBattery(DUMP({ extra: "  plugged: 2\n" })).plugged, "usb", "a plugged: bit field is read when no X powered line says true");
  assert.equal(parseBattery("Can't find service: battery"), null);
  assert.equal(parseBattery(""), null);
  assert.equal(parseBattery("level: abc"), null);
  assert.equal(parseBattery(DUMP({ level: 50 }).replace("scale: 100", "scale: 200")).pct, 25, "scale is honoured");
});

test("device filter: the POCO by address, model or codename; the S24 never, under any name", () => {
  assert.ok(isPoco({ serial: "192.168.1.78:40881" }));
  assert.ok(isPoco({ serial: "adb-XYZ._adb-tls-connect._tcp", model: "2311DRK48G" }));
  assert.ok(isPoco({ serial: "abc", device: "duchamp" }));
  assert.ok(!isPoco({ serial: "adb-R5TEST00000-abc._adb-tls-connect._tcp", model: "SM_S928B" }));
  assert.ok(!isPoco({ serial: "R5TEST00000", model: "2311DRK48G" }), "an S24 serial wins over any POCO-looking field");
  assert.ok(isS24({ serial: "x", device: "e3q" }));
  assert.ok(!isPoco({ serial: "emulator-5554", model: "sdk" }));
  assert.throws(() => assertPoco({ serial: "adb-R5TEST00000-abc._adb-tls-connect._tcp", model: "SM_S928B" }), /S24/);
  assert.throws(() => assertPoco({ serial: "10.0.0.9:5555", model: "Pixel" }), /not the POCO/);
  assert.throws(() => assertPoco({ serial: "192.168.1.78:5555;reboot" }), /unexpected/);
  assert.equal(assertPoco({ serial: "192.168.1.78:40881" }), "192.168.1.78:40881");
});

test("rules: one low reminder per crossing, re-armed at 30 %", () => {
  let st = {}, t = 0, fired = [];
  const feed = (pct, charging = false) => { const r = step(st, { pct, charging, plugged: charging ? "usb" : "none" }, t += 5 * 60e3); st = r.state; fired.push(...r.fire.map(f => `${f.kind}@${pct}`)); };
  for (const p of [40, 30, 26, 25, 24, 22, 20]) feed(p);
  assert.deepEqual(fired, ["low@25"], "25 % or less, not charging: once");
  feed(20, true); feed(24, true); feed(27, false); feed(25, false);
  assert.deepEqual(fired, ["low@25"], "charging to 27 % and back to 25 % is not a new crossing");
  t += COOLDOWN_MS; feed(31); feed(25);
  assert.deepEqual(fired, ["low@25", "low@25"], "back above 30 %, then down again: a new crossing");
});

test("rules: high at 90 % while charging, re-armed when unplugged or at 85 %; cooldown stops a flapping cable", () => {
  let st = {}, t = 0, fired = [];
  const feed = (pct, charging) => { const r = step(st, { pct, charging, plugged: charging ? "ac" : "none" }, t += 5 * 60e3); st = r.state; fired.push(...r.fire.map(f => `${f.kind}@${pct}`)); };
  feed(80, true); feed(89, true); feed(90, true); feed(94, true); feed(100, true);
  assert.deepEqual(fired, ["high@90"]);
  feed(100, false); feed(99, true);
  assert.deepEqual(fired, ["high@90"], "unplugged and plugged again within 30 min: re-armed but held by the cooldown");
  t += COOLDOWN_MS; feed(98, false); feed(98, true);
  assert.deepEqual(fired, ["high@90", "high@98"], "after the cooldown a re-plug at 98 % reminds once");
  feed(91, false);
  assert.equal(step(st, { pct: 92, charging: false }).fire.length, 0, "90 % and not charging: nothing");
});

test("rules: message text and fields", () => {
  const low = step({}, { pct: 18, charging: false, plugged: "none" }, Date.parse("2026-11-03T10:00:00Z")).fire[0];
  assert.deepEqual({ ...low }, { id: "poco-battery", kind: "low", pct: 18, charging: false, plugged: "none", title: "POCO battery low",
    at: "2026-11-03T10:00:00.000Z", body: "POCO battery 18 %: plug it in." });
  assert.match(step({}, { pct: 18, charging: false, plugged: "usb" }).fire[0].body, /not charging on its cable/);
  assert.match(step({}, { pct: 93, charging: true, plugged: "ac" }).fire[0].body, /^POCO at 93 % and charging: unplug it/);
});

function fakeAdb({ devices = DEVICES, dump = () => DUMP(), connectAdds = null } = {}) {
  const calls = []; let list = devices;
  const run = async (exe, args, timeout) => {
    calls.push(args.join(" "));
    if (args[0] === "devices") return list;
    if (args[0] === "connect") { if (connectAdds) list = connectAdds; return "connected"; }
    if (args[0] === "-s" && args[2] === "shell" && args[3] === "dumpsys" && args[4] === "battery") {
      if (args[1].includes("R5TEST00000")) throw new Error("TEST FAILURE: the S24 was read");
      return dump();
    }
    throw new Error("unexpected adb call: " + args.join(" "));
  };
  return { run, calls, setList: l => { list = l; } };
}

test("monitor: reads only the POCO, by its listed serial; snapshot keeps the serial private", async () => {
  const a = fakeAdb({ dump: () => DUMP({ level: 57, status: 2, usb: true, temp: 335 }) });
  const m = createPocoBattery({ run: a.run });
  const s = await m.poll();
  assert.deepEqual([s.online, s.pct, s.charging, s.plugged, s.temp_c, s.status_name], [true, 57, true, "usb", 33.5, "charging"]);
  assert.equal(s.serial, undefined);
  assert.ok(a.calls.includes("-s 192.168.1.78:40881 shell dumpsys battery"));
  assert.ok(!a.calls.some(c => c.includes("R5TEST00000")), "the S24 is never targeted");
  assert.ok(!a.calls.some(c => /kill-server|pair|install|connect/.test(c)), "listed: no connect, nothing else");
});

test("monitor: POCO missing -> one connect to 192.168.1.78:5555; S24 alone is never read; failure keeps the last reading offline", async () => {
  const a = fakeAdb({ devices: S24_ONLY });
  const m = createPocoBattery({ run: a.run });
  let s = await m.poll();
  assert.equal(s.online, false);
  assert.match(s.error, /not on adb/);
  assert.deepEqual(a.calls.filter(c => c.startsWith("connect")), ["connect 192.168.1.78:5555"]);
  assert.ok(!a.calls.some(c => c.startsWith("-s")), "with only the S24 listed, no shell command runs at all");

  a.setList(DEVICES);
  s = await m.poll();
  assert.deepEqual([s.online, s.pct], [true, 64]);
  a.setList("List of devices attached\n");
  s = await m.poll();
  assert.deepEqual([s.online, s.pct], [false, 64], "the last good reading stays, marked offline");
});

test("monitor: reminders go to onReminder and the push, once; the state file stops a restart reminding again", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poco-")), stateFile = path.join(dir, "poco-battery.json");
  let level = 30;
  const a = fakeAdb({ dump: () => DUMP({ level, status: 3 }) });
  const got = [], pushed = [];
  const mk = () => createPocoBattery({ run: a.run, stateFile, onReminder: r => got.push(r.kind), push: async r => { pushed.push(r.kind); } });
  const m = mk();
  await m.poll(); level = 24; await m.poll(); await m.poll();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(got, ["low"]); assert.deepEqual(pushed, ["low"]);
  assert.equal(m.snapshot().low, true);
  assert.deepEqual(m.snapshot().armed, { low: false, high: true });
  const m2 = mk();                         // a hub restart while still at 24 %
  await m2.poll();
  assert.deepEqual(got, ["low"], "no second reminder after the restart");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("monitor: garbled dumpsys and adb errors never remind and never throw", async () => {
  const m = createPocoBattery({ run: async (e, args) => { if (args[0] === "devices") return DEVICES; throw new Error("timed out"); }, onReminder: () => assert.fail("reminded") });
  const s = await m.poll();
  assert.deepEqual([s.online, s.error], [false, "timed out"]);
  const m2 = createPocoBattery({ run: async (e, args) => args[0] === "devices" ? DEVICES : "Can't find service: battery", onReminder: () => assert.fail("reminded") });
  assert.equal((await m2.poll()).online, false);
});

test("ntfy push stub: off by default; quiet hours; posts title, priority and the body when switched on", async () => {
  const r = { kind: "low", title: "POCO battery low", body: "POCO battery 20 %: plug it in." };
  assert.deepEqual(await createNtfyPush()(r), { sent: false, why: "off" });
  const sent = [];
  const fetchFn = async (url, o) => { sent.push({ url, o }); return { ok: true, status: 200 }; };
  const p = createNtfyPush({ enabled: true, topic: "test-topic-123", fetchFn, server: "https://ntfy.example" });
  assert.deepEqual(await p(r, Date.parse("2026-11-03T16:30:00Z")), { sent: false, why: "quiet hours" }, "00:30 SGT");
  assert.deepEqual(await p(r, Date.parse("2026-11-03T04:00:00Z")), { sent: true }, "12:00 SGT");
  assert.equal(sent[0].url, "https://ntfy.example/test-topic-123");
  assert.deepEqual([sent[0].o.method, sent[0].o.body, sent[0].o.headers.Title, sent[0].o.headers.Priority], ["POST", r.body, r.title, "high"]);
  assert.deepEqual(await createNtfyPush({ enabled: true, topicFile: path.join(os.tmpdir(), "no-such-topic-file.txt"), fetchFn })(r, Date.parse("2026-11-03T04:00:00Z")),
    { sent: false, why: "no topic file" });
  assert.deepEqual(await createNtfyPush({ enabled: true, topic: "../evil", fetchFn })(r, Date.parse("2026-11-03T04:00:00Z")), { sent: false, why: "bad topic" });
});
