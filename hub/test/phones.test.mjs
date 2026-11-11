import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { parseDevices, parseDumpsysBattery, createPhoneMonitor } from "../lib/phones.mjs";

// the example phones (read lazily, at each call): a reminder phone and a read-only one
process.env.TV_PHONES_FILE = fileURLToPath(new URL("./fixtures/phones.json", import.meta.url));

const DEVICES = `List of devices attached
192.168.1.78:40881    device product:duchamp_global model:2311DRK48G device:duchamp transport_id:49
adb-R5TEST00000-abc123._adb-tls-connect._tcp device product:e3qxxx model:SM_S928B device:e3q transport_id:50
emulator-5554          device product:sdk model:sdk transport_id:1
`;
const battery = (level, status, ac = "false") => `Current Battery Service state:
  AC powered: ${ac}
  USB powered: false
  status: ${status}
  level: ${level}
  scale: 100
  temperature: 329
`;

test("adb device list: emulators skipped, fields read", () => {
  const d = parseDevices(DEVICES);
  assert.equal(d.length, 2);
  assert.deepEqual(d[0], { serial: "192.168.1.78:40881", state: "device", model: "2311DRK48G", device: "duchamp", product: "duchamp_global" });
});

test("dumpsys battery: level, charging (status 2), plugged, temperature in tenths", () => {
  assert.deepEqual(parseDumpsysBattery(battery(100, 5, "true")), { pct: 100, charging: false, plugged: true, full: true, temp_c: 32.9, status: 5 });
  assert.equal(parseDumpsysBattery(battery(40, 2)).charging, true);
  assert.equal(parseDumpsysBattery("nothing"), null);
});

test("monitor: S24 only read when listed, never connected; POCO connected once; low flag; last reading kept offline", async () => {
  const calls = [];
  let list = DEVICES, pocoLevel = 18;
  const run = async (exe, args) => {
    calls.push(args.join(" "));
    if (args[0] === "devices") return list;
    if (args[0] === "connect") return "failed to connect";
    if (args[1].startsWith("192.168.1.78")) return battery(pocoLevel, 3);
    if (args[1].includes("R5TEST00000")) return battery(70, 2);
    throw new Error("unexpected");
  };
  const changes = [];
  const m = createPhoneMonitor({ run, onChange: l => changes.push(l) });
  let r = await m.poll();
  const poco = r.find(p => p.id === "poco"), s24 = r.find(p => p.id === "s24");
  assert.deepEqual([poco.pct, poco.low, poco.online], [18, true, true]);
  assert.deepEqual([s24.pct, s24.charging, s24.low], [70, true, false]);
  assert.ok(!calls.some(c => c.startsWith("connect")), "nothing connects when both are listed");
  assert.ok(!calls.some(c => /kill-server|pair|install/.test(c)));

  list = "List of devices attached\n";
  r = await m.poll();
  assert.deepEqual(r.find(p => p.id === "poco").online, false);
  assert.equal(r.find(p => p.id === "poco").pct, 18, "the last good reading stays");
  const connects = calls.filter(c => c.startsWith("connect"));
  assert.deepEqual(connects, ["connect 192.168.1.78:5555"], "one connect attempt, for the POCO only");
  assert.equal(changes.length, 2);
});
