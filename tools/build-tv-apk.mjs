#!/usr/bin/env node
// build-tv-apk.mjs: builds the designyourtv APK (screensaver + Wallpaper tile + Claude tile) without Gradle.
//   node tools/build-tv-apk.mjs --hub http://<hub-ip>:8790 [--offline-plate <id>]
//                                             memory gate, unit tests, aapt2, javac, d8, zipalign, apksigner, checks
//   node tools/build-tv-apk.mjs --test-only  only the plain-JVM unit tests of the core classes
// --hub (or TV_HUB) is the hub the TV opens; it is written into HubChooser.java and the cleartext rule of
// network_security_config.xml in a staged copy, so the sources keep the example address. --offline-plate (default
// "placeholder", TV_OFFLINE_PLATE) is the plate in plates/ the offline page shows when the hub doesn't answer.
// Output: apk/tv-dream/designyourtv.apk (+ .sha256, build-info.json), git-ignored. Debug-signed with
// apk/tv-dream/debug.jks (made on first build, so every builder has their own key; the standard Android debug password
// "android"; git-ignored).
// Every child process runs hidden (windowsHide). Intermediates go to the OS temp folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, "..");
const SRC = path.join(HERE, "tv-dream");
const OUT = path.join(PROJECT, "apk", "tv-dream");
const SDK = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || path.join(os.homedir(), "AppData", "Local", "Android", "Sdk");
const JAVA_HOME = process.env.JAVA_HOME;
if (!JAVA_HOME) { console.error("set JAVA_HOME to a JDK 17 (for example the Microsoft Build of OpenJDK)"); process.exit(1); }
const VERSION = { code: 32, name: "1.0.31" };
// targetSdk 26 on purpose: IWindowManager.setForcedDisplayDensityForUser is on the hidden-API list "max-target-o", so
// an app targeting 27+ is denied it (measured on the API 33 emulator, 3 Nov: "max-target-o, reflection, denied").
// Android 14 installs apps targeting 23+. The app has no runtime permissions, so nothing else depends on a newer target.
const MIN_SDK = 23, TARGET_SDK = Number(process.env.TV_TARGET_SDK || 26), COMPILE_SDK = 34;
const testOnly = process.argv.includes("--test-only");
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const EXAMPLE_HUB = "http://192.168.1.10:8790";
const HUB = (arg("--hub") || process.env.TV_HUB || "").replace(/\/$/, "");
// --mirror (or TV_MIRROR): an optional second server the TV falls back to while the hub is off; without one, the hub again
const EXAMPLE_MIRROR = "http://192.168.1.11:8792";
const MIRROR = (arg("--mirror") || process.env.TV_MIRROR || HUB).replace(/\/$/, "");
const OFFLINE_PLATE = arg("--offline-plate") || process.env.TV_OFFLINE_PLATE || "placeholder";
if (!testOnly && !/^http:\/\/[\w.-]+:\d{2,5}$/.test(HUB)) { console.error("give the hub with --hub http://<hub-ip>:8790 (or TV_HUB)"); process.exit(2); }

const log = s => console.log(s);
function run(file, args, opt = {}) {
  const bat = /\.bat$/i.test(file);
  for (const a of args) if (bat && /["%^&|<>]/.test(a)) throw new Error(`refusing argument ${a}`);
  const exe = bat ? (process.env.ComSpec || "cmd.exe") : file;
  const argv = bat ? ["/d", "/s", "/c", `""${file}" ${args.map(a => `"${a}"`).join(" ")}"`] : args;
  try {
    return execFileSync(exe, argv, { windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsVerbatimArguments: bat, stdio: ["ignore", "pipe", "pipe"], ...opt });
  } catch (e) {
    throw new Error(`${path.basename(file)} failed (exit ${e.status}):\n${(e.stdout || "") + (e.stderr || "")}`.slice(0, 4000));
  }
}
function latest(dir) { return fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop(); }
function walk(dir, ext) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name), ext) : d.name.endsWith(ext) ? [path.join(dir, d.name)] : []); }

/* 1. memory gate (device rule: nothing heavy at or above 75 % committed) */
function memoryGate() {
  const out = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$o=Get-CimInstance Win32_OperatingSystem; [string]::Format('{0} {1}', ($o.TotalVirtualMemorySize-$o.FreeVirtualMemory), $o.TotalVirtualMemorySize)"]);
  const [used, total] = out.trim().split(/\s+/).map(Number);
  const pct = Math.round(100 * used / total);
  log(`memory: ${(used / 1048576).toFixed(1)} of ${(total / 1048576).toFixed(1)} GB committed (${pct} %)`);
  if (pct >= 75) { console.error(`memory gate: ${pct} % committed is at or above 75 %; not building. Close something, then run again.`); process.exit(5); }
}

const javac = path.join(JAVA_HOME, "bin", "javac.exe"), java = path.join(JAVA_HOME, "bin", "java.exe"), jar = path.join(JAVA_HOME, "bin", "jar.exe"), keytool = path.join(JAVA_HOME, "bin", "keytool.exe");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "designyourtv-build-"));

/* 2. unit tests: the pure-Java core on the laptop's JVM */
function unitTests() {
  const core = walk(path.join(SRC, "src", "dev", "designyourtv", "core"), ".java");
  const tests = walk(path.join(SRC, "test"), ".java");
  const cls = path.join(tmp, "test-classes");
  fs.mkdirSync(cls);
  run(javac, ["--release", "8", "-encoding", "UTF-8", "-nowarn", "-d", cls, ...core, ...tests]);
  let outp;
  try { outp = run(java, ["-cp", cls, "dev.designyourtv.core.CoreTest"]); }
  catch (e) { console.error(e.message); console.error("unit tests FAILED"); process.exit(1); }
  log(outp.trim().split(/\r?\n/).filter(l => !l.startsWith("PASS")).join("\n") || "(no output)");
  log(`unit tests: ${outp.split(/\r?\n/).filter(l => l.startsWith("PASS")).length} PASS, exit 0`);
}

if (testOnly) { unitTests(); process.exit(0); }
memoryGate();
unitTests();

const bt = path.join(SDK, "build-tools", latest(path.join(SDK, "build-tools")));
const androidJar = path.join(SDK, "platforms", `android-${COMPILE_SDK}`, "android.jar");
if (!fs.existsSync(androidJar)) { console.error(`missing ${androidJar}`); process.exit(1); }
const aapt2 = path.join(bt, "aapt2.exe"), aapt = path.join(bt, "aapt.exe"), d8 = path.join(bt, "d8.bat"), zipalign = path.join(bt, "zipalign.exe"), apksigner = path.join(bt, "apksigner.bat");
log(`build-tools ${path.basename(bt)}, android-${COMPILE_SDK}, JDK ${JAVA_HOME}`);

/* 3. resources and assets (the offline page plus the plate it shows, copied from plates/), in a staged copy with the hub */
const stage = path.join(tmp, "stage");
fs.cpSync(path.join(SRC, "src"), path.join(stage, "src"), { recursive: true });
fs.cpSync(path.join(SRC, "res"), path.join(stage, "res"), { recursive: true });
const swap = (f, a, b) => { const t = fs.readFileSync(f, "utf8"); if (!t.includes(a)) throw new Error(`${f} has no ${a}`); fs.writeFileSync(f, t.split(a).join(b)); };
swap(path.join(stage, "src", "dev", "designyourtv", "core", "HubChooser.java"), EXAMPLE_HUB, HUB);
swap(path.join(stage, "res", "xml", "network_security_config.xml"), ">192.168.1.10<", `>${new URL(HUB).hostname}<`);
swap(path.join(stage, "src", "dev", "designyourtv", "core", "HubChooser.java"), EXAMPLE_MIRROR, MIRROR);
if (new URL(MIRROR).hostname !== new URL(HUB).hostname)
  swap(path.join(stage, "res", "xml", "network_security_config.xml"), "    </domain-config>", `        <domain includeSubdomains="false">${new URL(MIRROR).hostname}</domain>\n    </domain-config>`);
log(`hub: ${HUB}, mirror: ${MIRROR}, offline plate: ${OFFLINE_PLATE}`);
for (const need of ["banner.png", "banner_claude.png", "icon.png", "icon_claude.png"])
  if (!fs.existsSync(path.join(SRC, "res", "drawable-xhdpi", need))) { console.error(`missing res/drawable-xhdpi/${need}: python -I tools/tv-dream/make-art.py`); process.exit(1); }
const assets = path.join(tmp, "assets");
fs.cpSync(path.join(SRC, "assets"), assets, { recursive: true });
for (const kind of ["plate", "fg"]) {
  const from = path.join(PROJECT, "plates", `${OFFLINE_PLATE}.${kind}.webp`);
  if (!fs.existsSync(from)) { console.error(`missing ${path.relative(PROJECT, from)}: make it with tools/depth_pipeline.py or tools/make-placeholder.py`); process.exit(1); }
  fs.copyFileSync(from, path.join(assets, "offline", `offline.${kind}.webp`));
}
const compiled = path.join(tmp, "res.zip");
run(aapt2, ["compile", "--dir", path.join(stage, "res"), "-o", compiled]);
const gen = path.join(tmp, "gen"); fs.mkdirSync(gen);
const unsigned = path.join(tmp, "unsigned.apk");
run(aapt2, ["link", "-I", androidJar, "--manifest", path.join(SRC, "AndroidManifest.xml"),
  "--min-sdk-version", String(MIN_SDK), "--target-sdk-version", String(TARGET_SDK),
  "--version-code", String(VERSION.code), "--version-name", VERSION.name, "--java", gen, "-o", unsigned, compiled]);
// Assets go in with aapt add and forward-slash names: aapt2's -A on Windows stores "assets/offline\index.html",
// which Android's asset manager never finds (measured 3 Nov: the offline page would have been missing on the TV).
const assetNames = walk(assets, "").map(f => "assets/" + path.relative(assets, f).split(path.sep).join("/"));
run(aapt, ["add", "-0", "webp", unsigned, ...assetNames], { cwd: tmp });

/* 4. code: javac (Java 8 bytecode against android.jar) -> jar -> d8 */
const classes = path.join(tmp, "classes"); fs.mkdirSync(classes);
run(javac, ["-source", "8", "-target", "8", "-bootclasspath", androidJar, "-encoding", "UTF-8", "-nowarn", "-Xlint:-options", "-d", classes,
  ...walk(path.join(stage, "src"), ".java"), ...walk(gen, ".java")]);
const classesJar = path.join(tmp, "classes.jar");
run(jar, ["cf", classesJar, "-C", classes, "."]);
const dex = path.join(tmp, "dex"); fs.mkdirSync(dex);
run(d8, ["--release", "--min-api", String(MIN_SDK), "--lib", androidJar, "--output", dex, classesJar]);
run(aapt, ["add", unsigned, "classes.dex"], { cwd: dex });

/* 5. align and sign */
const aligned = path.join(tmp, "aligned.apk");
run(zipalign, ["-p", "-f", "4", unsigned, aligned]);
fs.mkdirSync(OUT, { recursive: true });
const ks = path.join(OUT, "debug.jks");
if (!fs.existsSync(ks)) run(keytool, ["-genkeypair", "-keystore", ks, "-alias", "designyourtv", "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
  "-storepass", "android", "-keypass", "android", "-dname", "CN=designyourtv debug"]);
const apk = path.join(OUT, "designyourtv.apk");
run(apksigner, ["sign", "--ks", ks, "--ks-key-alias", "designyourtv", "--ks-pass", "pass:android", "--key-pass", "pass:android", "--out", apk, aligned]);

/* 6. checks on the result */
const verify = run(apksigner, ["verify", "--print-certs", "-v", apk]);
if (!/Verified using v2 scheme \(APK Signature Scheme v2\): true/.test(verify)) { console.error("apksigner verify failed:\n" + verify); process.exit(1); }
const badging = run(aapt2, ["dump", "badging", apk]);
const must = [
  [/package: name='dev\.designyourtv' versionCode='\d+' versionName='[\d.]+'/, "package and version"],
  [/minSdkVersion:'23'/, "minSdk 23"], [new RegExp(`targetSdkVersion:.${TARGET_SDK}.`), `targetSdk ${TARGET_SDK}`],
  [/leanback-launchable-activity: name='dev\.designyourtv\.ClaudeTile'/, "Claude tile on the TV home"],
  [/launchable-activity: name='dev\.designyourtv\.ClaudeTile'/, "Claude tile also as a phone-style launcher entry"],
  [/uses-permission: name='android\.permission\.WRITE_SECURE_SETTINGS'/, "WRITE_SECURE_SETTINGS declared"],
  [/uses-permission: name='android\.permission\.PACKAGE_USAGE_STATS'/, "PACKAGE_USAGE_STATS declared"],
];
for (const [re, what] of must) if (!re.test(badging)) { console.error(`badging check failed: ${what}`); process.exit(1); }
const xml = run(aapt2, ["dump", "xmltree", "--file", "AndroidManifest.xml", apk]);
const checksX = [
  [/android\.service\.dreams\.DreamService/, "the dream's intent filter"],
  [/android\.permission\.BIND_DREAM_SERVICE/, "the dream is bound only by the system"],
  [/HomeAlias[\s\S]{0,400}enabled\(0x0101000e\)=false/, "the HOME alias ships disabled"],
  [/android\.intent\.action\.BOOT_COMPLETED/, "the boot receiver"],
  [/networkSecurityConfig/, "network security config"],
];
for (const [re, what] of checksX) if (!re.test(xml)) { console.error(`manifest check failed: ${what}`); process.exit(1); }
const files = run(aapt, ["list", apk]);
const bad = files.split(/\r?\n/).filter(f => f.includes("\\"));
if (bad.length) { console.error(`APK entries with a backslash (Android can't open them): ${bad.join(", ")}`); process.exit(1); }
for (const f of ["classes.dex", "assets/offline/index.html", "assets/offline/offline.plate.webp", "assets/offline/offline.fg.webp", "assets/tvnav.js", "res/xml/network_security_config.xml"])
  if (!files.split(/\r?\n/).includes(f)) { console.error(`missing from the APK: ${f}`); process.exit(1); }
const sha = crypto.createHash("sha256").update(fs.readFileSync(apk)).digest("hex");
const cert = (/Signer #1 certificate SHA-256 digest: ([0-9a-f]+)/.exec(verify) || [])[1];
fs.writeFileSync(apk + ".sha256", `${sha}  designyourtv.apk\n`);
fs.writeFileSync(path.join(OUT, "build-info.json"), JSON.stringify({ built: new Date().toISOString(), version: VERSION, minSdk: MIN_SDK, targetSdk: TARGET_SDK,
  compileSdk: COMPILE_SDK, buildTools: path.basename(bt), sha256: sha, signerSha256: cert, bytes: fs.statSync(apk).size }, null, 2) + "\n");
log(`built ${path.relative(PROJECT, apk)} (${(fs.statSync(apk).size / 1024).toFixed(0)} KB) sha256 ${sha.slice(0, 16)}… signer ${cert && cert.slice(0, 16)}…`);
log("checks: signature v2, badging (package, SDKs, TV tile, permissions), manifest (dream, HOME alias off, boot receiver, cleartext config), contents: all passed");
