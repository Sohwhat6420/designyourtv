import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { quietHub, raw, collectSse } from "./helpers.mjs";
import { mergePatch, KEEP_VERSIONS } from "../lib/config-store.mjs";

const hub = await quietHub();
test.after(() => hub.close());
const json = { "content-type": "application/json" };

test("merge patch: objects merge, values replace, null removes, prototype keys ignored", () => {
  const out = mergePatch({ a: 1, s: { x: 1, y: 2 }, arr: [1, 2] }, JSON.parse('{"s":{"y":null,"z":3},"arr":[9],"__proto__":{"polluted":1}}'));
  assert.deepEqual(out, { a: 1, s: { x: 1, z: 3 }, arr: [9] });
  assert.equal({}.polluted, undefined);
});

test("PATCH choices merges into the plate and keeps history", async () => {
  let r = await raw(hub.port, "/api/config/choices/placeholder", { method: "PATCH", headers: json, body: { settings: { font: "a", size: 3 }, status: "keep" } });
  assert.equal(r.status, 200);
  r = await raw(hub.port, "/api/config/choices/placeholder", { method: "PATCH", headers: json, body: { settings: { size: 5 }, feedback: "nice" } });
  const doc = JSON.parse(r.body);
  assert.deepEqual(doc.choices.placeholder, { settings: { font: "a", size: 5 }, status: "keep", feedback: "nice" });
  assert.ok(doc.updatedAt);
  const stored = JSON.parse(fs.readFileSync(hub.config.file, "utf8"));
  assert.deepEqual(stored.choices.placeholder.settings, { font: "a", size: 5 });
  assert.ok(hub.config.history().length >= 1, "the replaced version is kept");
});

test("PATCH globals/tv merges; GET returns the whole document", async () => {
  await raw(hub.port, "/api/config/globals/tv", { method: "PATCH", headers: json, body: { interval: 300, dockShow: "always" } });
  await raw(hub.port, "/api/config/globals/tv", { method: "PATCH", headers: json, body: { interval: 120 } });
  const g = JSON.parse((await raw(hub.port, "/api/config")).body);
  assert.deepEqual(g.globals.tv, { interval: 120, dockShow: "always" });
});

test("history keeps only the newest 20 versions", async () => {
  for (let i = 0; i < KEEP_VERSIONS + 5; i++) await raw(hub.port, "/api/config/globals/tv", { method: "PATCH", headers: json, body: { n: i } });
  assert.equal(hub.config.history().length, KEEP_VERSIONS);
});

test("bad bodies are refused", async () => {
  assert.equal((await raw(hub.port, "/api/config", { method: "PUT", headers: json, body: "[1,2]" })).status, 400);
  assert.equal((await raw(hub.port, "/api/config", { method: "PUT", headers: json, body: "not json" })).status, 400);
  assert.equal((await raw(hub.port, "/api/config", { method: "PUT", headers: json, body: { choices: [] } })).status, 400);
  assert.equal((await raw(hub.port, "/api/config/choices/placeholder", { method: "PATCH", headers: json, body: "42" })).status, 400);
  assert.equal((await raw(hub.port, "/api/config/choices/__proto__", { method: "PATCH", headers: json, body: {} })).status, 400);
  assert.equal((await raw(hub.port, "/api/config/other/x", { method: "PATCH", headers: json, body: {} })).status, 404);
  assert.equal((await raw(hub.port, "/api/config", { method: "PUT", headers: json, body: { big: "x".repeat(300 << 10) } })).status, 413);
  assert.equal((await raw(hub.port, "/api/config/choices/placeholder", { method: "PATCH", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await raw(hub.port, "/api/config/choices/placeholder", { method: "PATCH", headers: { ...json, origin: "https://evil.example" }, body: {} })).status, 403);
});

test("PUT replaces the whole document", async () => {
  const r = await raw(hub.port, "/api/config", { method: "PUT", headers: json, body: { choices: { biplane: { status: "remove" } }, globals: {} } });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body).choices, { biplane: { status: "remove" } });
});

test("the event stream sends a config event after a PATCH", async () => {
  const got = collectSse(`${hub.url}/api/events`, ev => ev.some(e => e.ev === "config"));
  await new Promise(r => setTimeout(r, 150));
  await raw(hub.port, "/api/config/choices/ship", { method: "PATCH", headers: json, body: { status: "keep" } });
  const events = await got;
  assert.equal(events[0].ev, "hello");
  const c = events.find(e => e.ev === "config");
  assert.ok(c, "config event arrived");
  assert.equal(c.data.what, "choices/ship");
});

test("a pushed device's stats come back with their age", async () => {
  assert.equal((await raw(hub.port, "/api/system/travel-test")).status, 404);
  const r = await raw(hub.port, "/api/system/travel-test", { method: "POST", headers: json, body: { cpu_pct: 12.5, ram: { pct: 40 } } });
  assert.equal(r.status, 200);
  const g = JSON.parse((await raw(hub.port, "/api/system/travel-test")).body);
  assert.equal(g.cpu_pct, 12.5); assert.ok(g.age_s >= 0);
  assert.equal((await raw(hub.port, "/api/system/travel-test", { method: "POST", headers: json, body: { x: "y".repeat(20 << 10) } })).status, 413);
  const d = JSON.parse((await raw(hub.port, "/api/devices")).body);
  assert.equal(d.pushed[0].device, "travel-test");
});
