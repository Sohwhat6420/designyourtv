import test from "node:test";
import assert from "node:assert/strict";
import { quietHub, raw } from "./helpers.mjs";
import { createMediaControl } from "../lib/media-control.mjs";

const POST = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
const pressed = [];
const media = createMediaControl({ run: async act => (pressed.push(act), { ok: true, act }) });
const hub = await quietHub({ media });
test.after(() => hub.close());

test("POST /api/media/:act presses the key once and answers ok", async () => {
  const r = await raw(hub.port, "/api/media/playpause", POST);
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).ok, true);
  assert.deepEqual(pressed, ["playpause"]);
  assert.equal((await raw(hub.port, "/api/media/next", POST)).status, 200);
  assert.deepEqual(pressed, ["playpause", "next"]);
});

test("an unknown action is 400 and presses nothing; GET is not an endpoint", async () => {
  const r = await raw(hub.port, "/api/media/shutdown", POST);
  assert.equal(r.status, 400);
  assert.equal((await raw(hub.port, "/api/media/next")).status, 404);
  assert.deepEqual(pressed, ["playpause", "next"]);
});

test("a press while one is running is dropped, not queued", async () => {
  let release;
  const slow = createMediaControl({ run: act => new Promise(r => { release = () => r({ ok: true, act }); }) });
  const first = slow.press("next");
  assert.equal((await slow.press("next")).why, "busy");
  release(); assert.equal((await first).ok, true);
});
