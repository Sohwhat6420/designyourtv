// The TV's event stream without the desk laptop's system readings (?skip=system), and the POCO battery endpoint.
import test from "node:test";
import assert from "node:assert/strict";
import { quietHub, raw, collectSse } from "./helpers.mjs";

const fakeMonitor = () => ({ snapshot: () => ({ cpu_pct: 9 }), nowPlaying: () => ({ status: "stopped" }), on() {}, stop() {} });

test("stream: ?skip=system leaves out the system readings and nothing else", async () => {
  const hub = await quietHub({ monitor: fakeMonitor(), systemMs: 100 });
  try {
    const plainP = collectSse(`${hub.url}/api/events`, ev => ev.filter(e => e.ev === "system").length >= 3, 2500);
    const tvP = collectSse(`${hub.url}/api/events?device=tv&skip=system`, () => false, 1200);
    await new Promise(r => setTimeout(r, 300));
    const devs = JSON.parse((await raw(hub.port, "/api/devices")).body);
    assert.ok(devs.streams.some(s => s.device === "tv" && s.skip?.[0] === "system"), "the status page sees the TV's stream and its skip");
    const [plain, tv] = await Promise.all([plainP, tvP]);
    assert.ok(plain.filter(e => e.ev === "system").length >= 3, "a plain stream gets the system readings");
    assert.equal(tv.filter(e => e.ev === "system").length, 0, "the TV's stream gets none");
    assert.ok(tv.some(e => e.ev === "hello") && tv.some(e => e.ev === "nowplaying"), "the rest still arrives");
  } finally { await hub.close(); }
});

test("stream: skip accepts only known event names", async () => {
  const hub = await quietHub({ monitor: fakeMonitor(), systemMs: 100 });
  try {
    const ev = await collectSse(`${hub.url}/api/events?skip=hello,config,reminder`, e => e.some(x => x.ev === "hello"), 1500);
    assert.ok(ev.some(e => e.ev === "hello"), "an unknown or protected name is ignored");
  } finally { await hub.close(); }
});

test("poco: a test hub has no reader unless given one; /api/poco-battery serves its snapshot", async () => {
  const none = await quietHub();
  try { assert.deepEqual(JSON.parse((await raw(none.port, "/api/poco-battery")).body), { available: false }); }
  finally { await none.close(); }
  const snap = { id: "poco", online: true, pct: 22, charging: false, low: true };
  const hub = await quietHub({ poco: { snapshot: () => snap, stop() {} } });
  try { assert.deepEqual(JSON.parse((await raw(hub.port, "/api/poco-battery")).body), snap); }
  finally { await hub.close(); }
});
