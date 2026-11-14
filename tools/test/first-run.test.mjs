// node --test tools/test/first-run.test.mjs
// A fresh Google TV, through the REAL tv-guard and the fake adb (tools/test/fake-adb.mjs): the install that the README's
// first run sends must go out from the screens a new owner is actually on, and must still stop over an app someone
// is watching. tv-apply's --selftest runs the guard as allow-all, which is how these refusals reached a real TV unseen.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { guardedAdb, realAdb } from "../tv-apply.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fake-adb.mjs");
const TV = "192.168.1.123:5555";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dyt-first-run-"));
const state = path.join(tmp, "state.json");
Object.assign(process.env, {
  FAKE_ADB_STATE: state, FAKE_TV_PROFILE: "gtv14", FAKE_UNDO_DIR: tmp,
  TV_GUARD_LOG: path.join(tmp, "guard.log"), TV_GUARD_CONFIG: path.join(tmp, "no-tv-guard.json"),
});
delete process.env.TV_GUARD_QUIET_HOURS;
delete process.env.TV_GUARD_ALLOW_EVENING;
execFileSync(process.execPath, [FAKE, "connect", TV], { windowsHide: true, env: process.env });

const apk = path.join(tmp, "designyourtv.apk");
fs.writeFileSync(apk, "PK");
const adb = guardedAdb(realAdb(FAKE), TV);
const readState = () => JSON.parse(fs.readFileSync(state, "utf8"));
const setTv = patch => fs.writeFileSync(state, JSON.stringify({ ...readState(), ...patch }));
const installs = () => readState().calls.filter(a => a.includes("install-multiple")).length;

async function tryInstall(front, extra = {}) {
  setTv({ foreground: front, wakefulness: "Awake", ...extra });
  const n = installs();
  try { await adb.installApks([apk]); return { sent: installs() > n }; }
  catch (e) { return { sent: installs() > n, error: e.message }; }
}

test("the TV's Settings app in front (where enabling debugging leaves you): the install goes out", async () => {
  const r = await tryInstall("com.android.tv.settings/.MainSettings");
  assert.equal(r.error, undefined); assert.equal(r.sent, true);
});

test("a home screen in front, on Google TV and on older Android TV: the install goes out", async () => {
  for (const front of ["com.google.android.apps.tv.launcherx/.home.HomeActivity", "com.google.android.leanbacklauncher/.MainActivity", "com.google.android.tvlauncher/.MainActivity"]) {
    const r = await tryInstall(front);
    assert.equal(r.error, undefined, front); assert.equal(r.sent, true, front);
  }
});

test("no quiet hours unless the owner sets them, whatever the clock says", async () => {
  const r = await tryInstall("com.google.android.apps.tv.launcherx/.home.HomeActivity");
  assert.equal(r.sent, true);
  process.env.TV_GUARD_QUIET_HOURS = "0-24";               // always quiet: the owner's own setting is still obeyed
  try {
    const q = await tryInstall("com.google.android.apps.tv.launcherx/.home.HomeActivity");
    assert.equal(q.sent, false); assert.match(q.error, /quiet hours/);
  } finally { delete process.env.TV_GUARD_QUIET_HOURS; }
});

test("someone watching YouTube: refused, nothing sent, and it says what to press", async () => {
  const r = await tryInstall("com.google.android.youtube.tv/.MainActivity");
  assert.equal(r.sent, false); assert.match(r.error, /youtube\.tv is in front.*Press Home on the remote/);
});

test("the TV went into its screensaver during the build: refused with what to do", async () => {
  const r = await tryInstall("com.google.android.apps.tv.launcherx/.home.HomeActivity", { wakefulness: "Dreaming" });
  assert.equal(r.sent, false); assert.match(r.error, /screensaver is running.*press any button on the remote/);
});

test("the fake adb saw no call to a phone", () => {
  assert.deepEqual(readState().violations.filter(v => /phone/.test(v)), []);
});
