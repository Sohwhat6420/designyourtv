import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { quietHub, raw, tmpDir } from "./helpers.mjs";
import { createWaitingReader, plainQuestion, projectOf } from "../lib/waiting.mjs";
import { parseForecast, createWeatherReader } from "../lib/weather.mjs";

test("waiting: fresh waits listed newest first with their project; old ones only counted", () => {
  const waits = tmpDir("waits"), projects = tmpDir("projects");
  const now = Date.parse("2026-11-03T06:00:00Z");
  fs.mkdirSync(path.join(projects, "C--Users-me-Notes")); fs.writeFileSync(path.join(projects, "C--Users-me-Notes", "aaaa1111-x.jsonl"), "");
  fs.mkdirSync(path.join(projects, "C--Users-me-Projects-Garden-Root")); fs.writeFileSync(path.join(projects, "C--Users-me-Projects-Garden-Root", "bbbb2222-y.jsonl"), "");
  fs.writeFileSync(path.join(waits, "aaaa1111-x.json"), JSON.stringify({ waits: [
    { id: "Garden lights", question: "Which fix first?", openedAt: now - 30 * 60e3 },
    { id: "Review 2", question: 'start "Review 2" (refused: needs a message he types in the desktop app)', openedAt: now - 5 * 24 * 3600e3 },
  ] }));
  fs.writeFileSync(path.join(waits, "bbbb2222-y.json"), JSON.stringify({ waits: [{ id: "harness", question: "Merge the fix?", openedAt: now - 5 * 60e3 }] }));
  fs.writeFileSync(path.join(waits, "broken.json"), "{not json");
  const r = createWaitingReader({ dir: waits, projectsDir: projects }).get(now);
  assert.equal(r.count, 2); assert.equal(r.older, 1);
  assert.deepEqual(r.items.map(i => [i.id, i.project, i.age_min]), [["harness", "Root", 5], ["Garden lights", "Notes", 30]]);
  assert.equal(projectOf("nope", projects), null);
  assert.equal(plainQuestion('start "X" (refused: needs a message he types in the desktop app)'), 'Start "X": type any message in the desktop app');
});

const NEA = { code: 0, data: { area_metadata: [], items: [{ timestamp: "2026-11-03T13:15:00+08:00",
  valid_period: { start: "2026-11-03T13:00:00+08:00", end: "2026-11-03T15:00:00+08:00", text: "1.00 pm to 3.00 pm" },
  forecasts: [{ area: "Clementi", forecast: "Thundery Showers" }, { area: "Ang Mo Kio", forecast: "Cloudy" }] }] } };

test("weather: one area from NEA's reply, cached, and a failure says so", async () => {
  assert.deepEqual(parseForecast(NEA, "clementi"), { area: "Clementi", forecast: "Thundery Showers", valid_text: "1.00 pm to 3.00 pm", valid_to: "2026-11-03T15:00:00+08:00", issued_at: "2026-11-03T13:15:00+08:00" });
  assert.equal(parseForecast(NEA, "Atlantis"), null);
  let calls = 0;
  const w = createWeatherReader({ fetchImpl: async () => { calls++; return { ok: true, json: async () => NEA }; } });
  assert.equal((await w.get("Clementi")).forecast, "Thundery Showers");
  await w.get("Ang Mo Kio");
  assert.equal(calls, 1, "one NEA call serves every area for 10 minutes");
  const bad = createWeatherReader({ fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal((await bad.get("Clementi")).available, false);
});

test("hub: /api/waiting and /api/weather answer, and a bad area is refused", async () => {
  const hub = await quietHub({ waiting: { get: () => ({ count: 1, older: 0, items: [{ id: "a", question: "q" }] }) },
    weather: { get: async area => ({ area, forecast: "Fair" }) } });
  try {
    assert.equal(JSON.parse((await raw(hub.port, "/api/waiting")).body).count, 1);
    assert.equal(JSON.parse((await raw(hub.port, "/api/weather?area=Ang%20Mo%20Kio")).body).area, "Ang Mo Kio");
    assert.equal((await raw(hub.port, "/api/weather?area=%3Cscript%3E")).status, 400);
  } finally { await hub.close(); }
});
