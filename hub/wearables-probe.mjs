// One-off, READ-ONLY probe for the watch and earbud levels on the phone marked "wearables" in hub/state/phones.json.
// Run it when that phone is listed by `adb devices`
// (the "Wireless debugging" tile on); it never connects, pairs, installs or changes anything and never touches the adb server.
//   node hub/wearables-probe.mjs                 prints what the hub would report, and every battery-ish line in the report
//   node hub/wearables-probe.mjs --save          also writes the raw report to hub/state/bt-dump.txt (git-ignored) so the
//                                                parser in lib/wearables.mjs can be corrected against real output
// The only command sent to the phone is `dumpsys bluetooth_manager`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { ADB, parseDevices, loadPhones } from "./lib/phones.mjs";
import { parseBluetoothDump, pickWearables } from "./lib/wearables.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const run = (args, timeout = 30e3) => new Promise((res, rej) => execFile(ADB, args, { windowsHide: true, timeout, encoding: "utf8", maxBuffer: 16 << 20 }, (e, out) => (e ? rej(e) : res(out))));

const s24 = loadPhones().find(p => p.wearables);
if (!s24) { console.log("No phone in hub/state/phones.json has \"wearables\": true."); process.exit(2); }
const dev = parseDevices(await run(["devices", "-l"])).find(d => d.state === "device" && s24.match(d));
if (!dev) { console.log("The wearables phone is not listed by adb. Turn on its Wireless debugging; nothing was run on it."); process.exit(2); }
const text = await run(["-s", dev.serial, "shell", "dumpsys", "bluetooth_manager"]);
if (process.argv.includes("--save")) { fs.mkdirSync(path.join(HERE, "state"), { recursive: true }); fs.writeFileSync(path.join(HERE, "state", "bt-dump.txt"), text); console.log("raw report saved to hub/state/bt-dump.txt"); }
const devices = parseBluetoothDump(text);
console.log(`report: ${text.split("\n").length} lines`);
console.log("parsed devices:", JSON.stringify(devices, null, 1));
console.log("picked:", JSON.stringify(pickWearables(devices), null, 1));
console.log("--- lines mentioning battery (values only; the addresses are already redacted by Android) ---");
for (const l of text.split(/\r?\n/)) if (/battery/i.test(l) && !/custom metadata\(/.test(l)) console.log(l.trim().slice(0, 200));
for (const l of text.split(/\r?\n/)) if (/custom metadata\(/.test(l)) console.log(l.trim().replace(/hfp client audio policy\([^)]*\)/, "").replace(/profile connection policy\([^)]*\)/, "").slice(0, 400));
