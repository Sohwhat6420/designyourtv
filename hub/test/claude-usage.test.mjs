// node --test hub/test
import test from "node:test";
import assert from "node:assert/strict";
import { parseStream, present, resetLabel } from "../lib/claude-usage.mjs";

const EV = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour",
  unifiedWindows: { five_hour: { utilization: 0.39, resetsAt: 1793682600 }, seven_day: { utilization: 0.14, resetsAt: 1793930400 } } } });

test("reads both windows from a stream-json event", () => {
  const r = parseStream(`{"type":"system"}\n${EV}\n{"type":"result"}`);
  assert.deepEqual(r.five_hour, { pct: 39, resets_at: 1793682600 });
  assert.deepEqual(r.seven_day, { pct: 14, resets_at: 1793930400 });
  assert.equal(r.walled, false);
});

test("no event means no reading, never zeros", () => {
  assert.equal(parseStream('{"type":"assistant"}'), null);
});

test("a wall with no numbers counts the binding window as full", () => {
  const r = parseStream(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1793682600 } }));
  assert.equal(r.five_hour.pct, 100); assert.equal(r.walled, true);
});

test("labels: hours and minutes within a day, else a Singapore day and time", () => {
  const now = Date.UTC(2026, 10, 3, 2, 51);
  assert.equal(resetLabel(1793682600, now), "2h 19m");
  assert.equal(resetLabel(1793930400, now), "Fri 10:00");
  assert.equal(resetLabel(now / 1000 - 5, now), "now");
});

test("a window that has reset since the reading shows 0 % marked new", () => {
  const r = { five_hour: { pct: 90, resets_at: 1793682600 }, seven_day: { pct: 61, resets_at: 1793930400 }, read_at: "2026-11-03T02:35:30Z", source: "t" };
  const p = present(r, Date.UTC(2026, 10, 3, 6, 0));
  assert.deepEqual([p.session.pct, p.session.reset, p.session.expired], [0, "new", true]);
  assert.equal(p.weekly.pct, 61);
  assert.equal(p.stale, true); // 3.4 h old
});
