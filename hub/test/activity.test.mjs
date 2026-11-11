import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { quietHub, raw, tmpDir } from "./helpers.mjs";

// The heatmap adds every laptop together: the hub's own file plus what each agent sends.
const root = tmpDir("act");
fs.mkdirSync(path.join(root, "data"), { recursive: true });
fs.writeFileSync(path.join(root, "data", "claude-activity.json"),
  JSON.stringify({ made: "2026-11-03T02:00:00Z", replies: { "2026-11-02": 10 }, tokens: { "2026-11-02": 1000 }, total: 5000 }));
const hub = await quietHub({ root });
test.after(() => hub.close());

test("an agent's count is added to the hub's own", async () => {
  const post = await raw(hub.port, "/api/activity/travel", { method: "POST", headers: { "content-type": "application/json" },
    body: { made: "2026-11-03T03:00:00Z", replies: { "2026-11-02": 5, "2026-11-03": 2, "bad": 9 }, tokens: { "2026-11-02": 300, "2026-11-03": -4 }, total: 700 } });
  assert.equal(post.status, 200, post.body);
  const j = JSON.parse((await raw(hub.port, "/api/activity")).body);
  assert.equal(j.replies["2026-11-02"], 15);
  assert.equal(j.replies["2026-11-03"], 2);
  assert.equal(j.replies.bad, undefined);                 // only real days are kept
  assert.equal(j.tokens["2026-11-02"], 1300);
  assert.equal(j.tokens["2026-11-03"], undefined);        // a negative count is dropped
  assert.equal(j.total, 5700);
  assert.deepEqual(j.devices.map(d => d.device).sort().length, 2);
});

test("a bad device name or body is refused and nothing is written", async () => {
  for (const [p, body] of [["/api/activity/..%2Fx", {}], ["/api/activity/a%20b", {}], ["/api/activity/ok", "[1,2]"]]) {
    const r = await raw(hub.port, p, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(r.status, 400, p);
  }
  assert.deepEqual(fs.readdirSync(path.join(root, "data")).sort(), ["claude-activity.json", "claude-activity.travel.json"]);
});
