// Galaxy Watch / Buds levels from the S24's `dumpsys bluetooth_manager`. The S24 was not reachable when this was built, so the
// fixtures are: (a) the metadata line shape CONFIRMED on a POCO X6 Pro (every value null), with the values filled in, and
// (b) the profile-block shapes written from the AOSP source. If the real S24 differs, `node hub/wearables-probe.mjs --save`
// captures it and these fixtures should be replaced by a trimmed copy.
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { quietHub, raw } from "./helpers.mjs";
import { parseBluetoothDump, parseMetadata, pickWearables, mergeWearables } from "../lib/wearables.mjs";
import { createPhoneMonitor } from "../lib/phones.mjs";

// the example phones (read lazily, at each call): a reminder phone and a read-only one
process.env.TV_PHONES_FILE = fileURLToPath(new URL("./fixtures/phones.json", import.meta.url));

// the real POCO key list and order, with values
const META_KEYS = ["manufacturer_name", "model_name", "software_version", "hardware_version", "companion_app", "main_icon", "is_untethered_headset",
  "untethered_left_icon", "untethered_right_icon", "untethered_case_icon", "untethered_left_battery", "untethered_right_battery", "untethered_case_battery",
  "untethered_left_charging", "untethered_right_charging", "untethered_case_charging", "enhanced_settings_ui_uri", "device_type", "main_battery", "main_charging"];
const metaLine = (addr, vals = {}) => `    ${addr} last_active_time=1793000000000 {profile connection policy(A2DP=100|HEADSET=100|BATTERY=-1), optional codec(support=-1|enabled=-1), isActiveHfpDevice (false), custom metadata(${
  META_KEYS.map(k => `${k}=${vals[k] ?? "null"}`).join("|")}), hfp client audio policy(callEstablishAudioPolicy=0|connectingTimeAudioPolicy=0)}`;

const BUDS_DUMP = `Bluetooth Status
  enabled: true
  address: 00:00:00:00:00:0B
  name: Galaxy S24 Ultra

AdapterProperties
  Name: Galaxy S24 Ultra
  Bonded devices:
    XX:XX:XX:XX:72:CA [BR/EDR] Galaxy Buds2 Pro (72CA)
    XX:XX:XX:XX:87:26 [BR/EDR] Galaxy Watch6 (8726)
    XX:XX:XX:XX:19:C1 [BR/EDR] JBL Flip 6

BluetoothDatabase:
  Metadata Changes:

Metadata:
${metaLine("XX:XX:XX:XX:72:CA", { model_name: "Galaxy Buds2 Pro", is_untethered_headset: "true", untethered_left_battery: 82, untethered_right_battery: 77, untethered_case_battery: 55, untethered_left_charging: "false", untethered_right_charging: "false", untethered_case_charging: "true" })}
${metaLine("XX:XX:XX:XX:87:26")}
${metaLine("XX:XX:XX:XX:19:C1", { main_battery: 40 })}

Profile: BatteryService
  BatteryStateMachine for XX:XX:XX:XX:87:26:
    mDevice: XX:XX:XX:XX:87:26
    mConnectionState: STATE_CONNECTED
    mBatteryLevel: 64
`;

test("metadata: the key list is read, 'null' dropped", () => {
  const m = parseMetadata(metaLine("XX:XX:XX:XX:72:CA", { untethered_left_battery: 82, device_type: "Untethered Headset" }));
  assert.equal(m.untethered_left_battery, "82"); assert.equal(m.device_type, "Untethered Headset"); assert.ok(!("main_battery" in m));
  assert.equal(parseMetadata("no metadata here"), null);
});

test("dump: buds from metadata (the weaker bud, the case apart), watch from its profile block, a speaker with a level kept as 'other'", () => {
  const d = parseBluetoothDump(BUDS_DUMP);
  const buds = d.find(x => x.id === "72:CA"), watch = d.find(x => x.id === "87:26"), spk = d.find(x => x.id === "19:C1");
  assert.deepEqual(buds, { id: "72:CA", name: "Galaxy Buds2 Pro", kind: "buds", pct: 77, left: 82, right: 77, case: 55, charging: true, connected: null });
  assert.deepEqual([watch.name, watch.kind, watch.pct, watch.connected], ["Galaxy Watch6", "watch", 64, true]);
  assert.deepEqual([spk.kind, spk.pct], ["other", 40]);
  assert.ok(!d.some(x => x.id === "5F:8B"), "the phone's own adapter address is not a device");
  const p = pickWearables(d);
  assert.deepEqual([p.watch.id, p.buds.id], ["87:26", "72:CA"]);
});

test("dump: the real POCO report (nothing bonded, every value null) gives no wearables", () => {
  const poco = `Bluetooth Status\n  enabled: false\n  address: 00:00:00:00:00:0B\n  name: POCO X6 Pro 5G\n\nAdapterProperties\n  Bonded devices:\n\nMetadata:\n${metaLine("XX:XX:XX:XX:72:CA")}\n${metaLine("XX:XX:XX:XX:87:26")}\n`;
  assert.deepEqual(parseBluetoothDump(poco), []);
  assert.deepEqual(parseBluetoothDump(""), []);
  assert.deepEqual(parseBluetoothDump(null), []);
});

test("dump: -1, out-of-range and junk levels are 'not reported'; a disconnected state is read", () => {
  const dump = `Metadata:\n${metaLine("XX:XX:XX:XX:72:CA", { model_name: "Galaxy Buds Live", untethered_left_battery: -1, untethered_right_battery: 101, main_battery: 55 })}
Profile: A2dpService
    XX:XX:XX:XX:72:CA
      mConnectionState: STATE_DISCONNECTED
      Battery level: 250
`;
  const [b] = parseBluetoothDump(dump);
  assert.deepEqual([b.kind, b.left, b.right, b.pct, b.connected], ["buds", null, null, 55, false]);
});

test("dump: a one-line 'address ... battery level: N' form is read, and a bud in the case (-1) does not drag the ring to zero", () => {
  const dump = `  XX:XX:XX:XX:AA:01 (Galaxy Watch5 Pro) battery level: 91\nMetadata:\n${metaLine("XX:XX:XX:XX:72:CA", { model_name: "Galaxy Buds FE", is_untethered_headset: "true", untethered_left_battery: 70, untethered_right_battery: -1 })}\n`;
  const d = parseBluetoothDump(dump);
  assert.deepEqual([d.find(x => x.id === "AA:01").pct, d.find(x => x.id === "72:CA").pct], [91, 70]);
});

test("merge: levels carry over, dim when the phone drops, and a disconnected device is flagged stale", () => {
  const t1 = "2026-11-03T06:00:00.000Z", t2 = "2026-11-03T06:05:00.000Z";
  let w = mergeWearables(null, parseBluetoothDump(BUDS_DUMP), t1, true);
  assert.equal(w.status, "ok");
  assert.deepEqual([w.watch.pct, w.watch.stale, w.buds.pct, w.buds.left, w.buds.case, w.buds.charging, w.read_at], [64, false, 77, 82, 55, true, t1]);
  assert.ok(w.devices.every(d => !("left" in d)), "the device list is brief");
  w = mergeWearables(w, null, t2, false);
  assert.deepEqual([w.phone_online, w.watch.pct, w.watch.stale, w.buds.pct, w.buds.stale], [false, 64, true, 77, true]);
  assert.equal(w.read_at, t1, "the time of the last good read");
  const gone = mergeWearables(w, [], t2, true);
  assert.deepEqual([gone.status, gone.watch.pct, gone.watch.stale], ["ok", 64, true], "absent from the report: last level, stale");
  const never = mergeWearables(null, [], t2, true);
  assert.deepEqual([never.status, never.watch, never.buds], ["none", null, null]);
  const disc = mergeWearables(null, [{ id: "A", name: "Galaxy Watch", kind: "watch", pct: 30, connected: false }], t1);
  assert.equal(disc.watch.stale, true);
  const unknown = mergeWearables(null, [{ id: "A", name: "Galaxy Watch", kind: "watch", pct: null, connected: true }], t1);
  assert.deepEqual([unknown.status, unknown.watch.pct], ["ok", null], "recognised but no level yet: the ring shows a dash");
});

const DEVICES = `List of devices attached
192.168.1.78:5555    device product:duchamp_global model:2311DRK48G device:duchamp transport_id:49
adb-R5TEST00000-abc123._adb-tls-connect._tcp device product:e3qxxx model:SM_S928B device:e3q transport_id:50
`;

test("monitor: the S24's Bluetooth report is read in the same poll, read-only, and never for the POCO", async () => {
  const calls = [], events = [];
  let list = DEVICES, btFails = false;
  const run = async (exe, args) => {
    calls.push(args.join(" "));
    if (args[0] === "devices") return list;
    if (args[0] === "connect") return "failed";
    const shell = args.slice(3).join(" ");
    if (shell === "dumpsys battery") return "  level: 70\n  scale: 100\n  status: 3\n  temperature: 300\n";
    if (shell === "dumpsys bluetooth_manager") { if (btFails) throw new Error("timed out"); assert.ok(args[1].includes("R5TEST00000"), "only the S24 is asked"); return BUDS_DUMP; }
    throw new Error("unexpected command: " + args.join(" "));
  };
  const m = createPhoneMonitor({ run, onWearables: w => events.push(w) });
  assert.equal(m.wearables().status, "unavailable");
  await m.poll();
  assert.deepEqual(calls.filter(c => c.includes("bluetooth")), ["-s adb-R5TEST00000-abc123._adb-tls-connect._tcp shell dumpsys bluetooth_manager"]);
  for (const c of calls) assert.ok(/^(devices -l|-s \S+ shell dumpsys (battery|bluetooth_manager))$/.test(c), "read-only commands only: " + c);
  assert.ok(!calls.some(c => /^(kill-server|pair|connect|disconnect|install|uninstall|push|reboot)/.test(c) || /shell (settings|input|pm|am|cmd|svc|setprop)/.test(c)));
  assert.equal(m.wearables().status, "ok"); assert.equal(m.wearables().buds.pct, 77);
  assert.equal(events.length, 1);
  await m.poll();
  assert.equal(events.length, 1, "an unchanged reading is not pushed again");

  btFails = true;
  const r = await m.poll();
  assert.equal(r.find(p => p.id === "s24").pct, 70, "a failed Bluetooth read leaves the battery alone");
  assert.equal(m.wearables().buds.pct, 77);

  btFails = false; list = "List of devices attached\n";
  await m.poll();
  assert.deepEqual([m.wearables().phone_online, m.wearables().buds.stale, m.wearables().watch.pct], [false, true, 64]);
  assert.equal(events.length, 2, "going stale is pushed once");
  assert.deepEqual(calls.filter(c => c.startsWith("connect")), ["connect 192.168.1.78:5555"], "only the POCO is ever connected to");
});

test("hub: /api/wearables serves the monitor's reading, 'unavailable' with no phone monitor", async () => {
  const none = await quietHub();
  try { assert.equal(JSON.parse((await raw(none.port, "/api/wearables")).body).status, "unavailable"); } finally { await none.close(); }
  const reading = mergeWearables(null, parseBluetoothDump(BUDS_DUMP), "2026-11-03T06:00:00.000Z", true);
  const hub = await quietHub({ phones: { list: () => [], wearables: () => reading, stop() {} } });
  try {
    const j = JSON.parse((await raw(hub.port, "/api/wearables")).body);
    assert.deepEqual([j.status, j.watch.name, j.buds.pct, j.phone], ["ok", "Galaxy Watch6", 77, "s24"]);
  } finally { await hub.close(); }
});
