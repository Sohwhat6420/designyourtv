import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { quietHub, raw, tmpDir } from "./helpers.mjs";
import { zonedToUtc, parseIcsDate, parseIcs, expandEvents, nextFromIcs, shortOf, sgtIso, scrub, readConfig, createNextReader } from "../lib/next.mjs";

// "now" is Tuesday 3 Nov 2026, 14:00 Singapore time (06:00 UTC)
const NOW = Date.parse("2026-11-03T06:00:00Z");
const ICS = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "BEGIN:VTIMEZONE", "TZID:Asia/Singapore", "BEGIN:STANDARD", "TZOFFSETFROM:+0800", "TZOFFSETTO:+0800", "TZNAME:SGT", "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE",
  // the card's current sample event
  "BEGIN:VEVENT", "UID:club@x", "DTSTART;TZID=Asia/Singapore:20261105T090000", "DTEND;TZID=Asia/Singapore:20261105T100000", "SUMMARY:Garden club: plant swap", "END:VEVENT",
  // twice a week, one Wednesday skipped, ends in December
  "BEGIN:VEVENT", "UID:lec@x", "DTSTART;TZID=Asia/Singapore:20261026T100000", "DTEND;TZID=Asia/Singapore:20261026T113000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T000000Z", "EXDATE;TZID=Asia/Singapore:20261104T100000", "SUMMARY:Evening class", "END:VEVENT",
  // three days only, the last of which has already ended today
  "BEGIN:VEVENT", "UID:stand@x", "DTSTART;TZID=Asia/Singapore:20261101T090000", "DTEND;TZID=Asia/Singapore:20261101T091500", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Stand-up", "END:VEVENT",
  // in progress now (UTC form)
  "BEGIN:VEVENT", "UID:dent@x", "DTSTART:20261103T053000Z", "DTEND:20261103T070000Z", "SUMMARY:Dentist", "LOCATION:High Street\\, Block 9", "END:VEVENT",
  // all day, with a folded, escaped title
  "BEGIN:VEVENT", "UID:bday@x", "DTSTART;VALUE=DATE:20261107", "DTEND;VALUE=DATE:20261108", "SUMMARY:Mum's birthday\\, with Jo and", "  Max", "END:VEVENT",
  "BEGIN:VEVENT", "UID:cancel@x", "DTSTART;TZID=Asia/Singapore:20261104T080000", "DTEND;TZID=Asia/Singapore:20261104T090000", "STATUS:CANCELLED", "SUMMARY:Cancelled thing", "END:VEVENT",
  "BEGIN:VEVENT", "UID:lunch@x", "DTSTART;TZID=Asia/Singapore:20261104T123000", "DTEND;TZID=Asia/Singapore:20261104T133000", "SUMMARY:Lunch", "END:VEVENT",
  // second Tuesday of each month
  "BEGIN:VEVENT", "UID:rent@x", "DTSTART;TZID=Asia/Singapore:20260908T190000", "DTEND;TZID=Asia/Singapore:20260908T200000", "RRULE:FREQ=MONTHLY;BYDAY=2TU", "SUMMARY:Cell group", "END:VEVENT",
  // every Friday, the 6 Nov one moved an hour later
  "BEGIN:VEVENT", "UID:book@x", "DTSTART;TZID=Asia/Singapore:20261030T190000", "DTEND;TZID=Asia/Singapore:20261030T210000", "RRULE:FREQ=WEEKLY;BYDAY=FR", "SUMMARY:Book club", "END:VEVENT",
  "BEGIN:VEVENT", "UID:book@x", "RECURRENCE-ID;TZID=Asia/Singapore:20261106T190000", "DTSTART;TZID=Asia/Singapore:20261106T200000", "DTEND;TZID=Asia/Singapore:20261106T220000", "SUMMARY:Book club (moved)", "END:VEVENT",
  "END:VCALENDAR", ""].join("\r\n");

test("time zones: Singapore is fixed +8, other zones follow their daylight saving", () => {
  assert.equal(zonedToUtc(2026, 11, 5, 9, 0, 0, "Asia/Singapore"), Date.parse("2026-11-05T01:00:00Z"));
  assert.equal(zonedToUtc(2026, 7, 1, 12, 0, 0, "America/New_York"), Date.parse("2026-07-01T16:00:00Z"));
  assert.equal(zonedToUtc(2026, 12, 1, 12, 0, 0, "America/New_York"), Date.parse("2026-12-01T17:00:00Z"));
  assert.equal(zonedToUtc(2026, 1, 1, 0, 0, 0, "Not/AZone"), Date.parse("2026-01-01T00:00:00Z"), "an unknown zone name falls back to UTC rather than throwing");
  assert.equal(sgtIso(Date.parse("2026-11-05T01:00:00Z")), "2026-11-05T09:00:00+08:00");
});

test("dates: all-day, UTC, zoned and floating forms", () => {
  assert.deepEqual(parseIcsDate("20261107", { VALUE: "DATE" }), { ms: Date.parse("2026-11-06T16:00:00Z"), allDay: true, ymd: [2026, 11, 7] });
  assert.equal(parseIcsDate("20261103T053000Z").ms, Date.parse("2026-11-03T05:30:00Z"));
  assert.equal(parseIcsDate("20261103T133000", { TZID: "Asia/Singapore" }).ms, Date.parse("2026-11-03T05:30:00Z"));
  assert.equal(parseIcsDate("20261103T133000").ms, Date.parse("2026-11-03T05:30:00Z"), "floating = Singapore time");
  assert.equal(parseIcsDate("garbage"), null);
});

test("ics: lines unfold, text unescapes, events are separated", () => {
  const evs = parseIcs(ICS);
  assert.equal(evs.length, 10);
  const b = evs.find(e => e.UID.value === "bday@x");
  assert.equal(b.SUMMARY.value, "Mum's birthday\\, with Jo and Max");
  assert.deepEqual(evs.find(e => e.UID.value === "lec@x").EXDATE.length, 1);
});

test("expand: weekly with BYDAY, EXDATE and UNTIL; COUNT; monthly 2nd Tuesday; a moved occurrence replaces its original", () => {
  const evs = parseIcs(ICS);
  const from = Date.parse("2026-11-01T00:00:00+08:00"), to = Date.parse("2026-11-16T00:00:00+08:00");
  const x = expandEvents(evs, from, to).map(e => `${e.title}@${sgtIso(e.start).slice(5, 16)}`);
  assert.deepEqual(x.filter(s => s.startsWith("Evening")), ["Evening class@11-02T10:00", "Evening class@11-09T10:00", "Evening class@11-11T10:00"], "Wed 4 Nov is excluded; Mon 16 is outside");
  assert.deepEqual(x.filter(s => s.startsWith("Stand")), ["Stand-up@11-01T09:00", "Stand-up@11-02T09:00", "Stand-up@11-03T09:00"], "COUNT=3");
  assert.deepEqual(x.filter(s => s.startsWith("Cell")), ["Cell group@11-10T19:00"]);
  assert.deepEqual(x.filter(s => s.startsWith("Book")), ["Book club (moved)@11-06T20:00", "Book club@11-13T19:00"], "the 6 Nov 19:00 original is replaced by the 20:00 one");
  assert.ok(!x.some(s => s.startsWith("Cancelled")));
  const until = expandEvents(evs, Date.parse("2026-12-28T00:00:00+08:00"), Date.parse("2027-01-20T00:00:00+08:00")).filter(e => e.title === "Evening class");
  assert.deepEqual(until.map(e => sgtIso(e.start).slice(5, 10)), ["12-28", "12-30"], "UNTIL 31 Dec 00:00 UTC (08:00 SGT) ends the series");
});

test("next: in-progress events, the next one, and the five after it", () => {
  const r = nextFromIcs(ICS, NOW);
  assert.deepEqual(r.now.map(e => e.title), ["Dentist"]);
  assert.equal(r.now[0].location, "High Street, Block 9"); assert.equal(r.now[0].started, true);
  assert.deepEqual(r.next, { title: "Lunch", short: "Lunch", start: "2026-11-04T12:30:00+08:00", end: "2026-11-04T13:30:00+08:00", all_day: false, location: null, in_min: 1350, started: false });
  assert.deepEqual(r.upcoming.map(e => e.title), ["Lunch", "Garden club: plant swap", "Book club (moved)", "Mum's birthday, with Jo and Max", "Evening class"]);
  const club = r.upcoming[1];
  assert.deepEqual([club.short, club.start, club.in_min], ["Garden club", "2026-11-05T09:00:00+08:00", 2580], "a dock chip gets a short label");
  assert.deepEqual([r.upcoming[3].all_day, r.upcoming[3].start], [true, "2026-11-07T00:00:00+08:00"]);
  assert.deepEqual(nextFromIcs("BEGIN:VCALENDAR\nEND:VCALENDAR", NOW), { next: null, now: [], upcoming: [] });
  assert.equal(shortOf("A very long calendar event title indeed").length, 18);
});

test("config: unconfigured until a real https address is in the file; webcal becomes https; the example is not a config", () => {
  const dir = tmpDir("cal"), f = path.join(dir, "calendar.json");
  assert.deepEqual(readConfig(f), { url: null, why: "no calendar.json yet" });
  fs.writeFileSync(f, "{nope"); assert.equal(readConfig(f).why, "calendar.json is not valid JSON");
  fs.writeFileSync(f, JSON.stringify({ ics_url: "REPLACE-WITH-THE-SECRET-ICAL-ADDRESS-FROM-GOOGLE-CALENDAR" })); assert.equal(readConfig(f).url, null);
  fs.writeFileSync(f, JSON.stringify({ ics_url: "http://insecure.example/x.ics" })); assert.equal(readConfig(f).url, null, "https only");
  fs.writeFileSync(f, JSON.stringify({ ics_url: "webcal://cal.example/private-abc/basic.ics", horizon_days: 9999 }));
  assert.deepEqual(readConfig(f), { url: "https://cal.example/private-abc/basic.ics", horizonDays: 366, tz: "Asia/Singapore" });
  const ex = JSON.parse(fs.readFileSync(new URL("../calendar.example.json", import.meta.url), "utf8"));
  const f2 = path.join(dir, "ex.json"); fs.writeFileSync(f2, JSON.stringify(ex));
  assert.equal(readConfig(f2).url, null, "the shipped example stays 'unconfigured'");
});

const SECRET = "https://calendar.example/ical/me%40example.com/private-9f8e7d6c5b4a/basic.ics";

test("reader: unconfigured without a file; fetches once for five minutes; stale-on-error; the address never leaks", async () => {
  const dir = tmpDir("cal"), f = path.join(dir, "calendar.json");
  let t = NOW, calls = 0, mode = "ok";
  const fetchImpl = async url => {
    calls++;
    assert.equal(url, SECRET);
    if (mode === "throw") throw new Error(`fetch failed for ${SECRET} (ECONNRESET)`);
    if (mode === "500") return { ok: false, status: 500, headers: { get: () => null }, text: async () => "" };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => ICS };
  };
  const logs = [];
  const r = createNextReader({ configFile: f, fetchImpl, now: () => t, log: (l, m) => logs.push(m) });
  const un = await r.get();
  assert.deepEqual([un.status, un.why, calls], ["unconfigured", "no calendar.json yet", 0]);
  assert.match(un.setup, /calendar\.json/);

  fs.writeFileSync(f, JSON.stringify({ ics_url: SECRET }));
  const a = await r.get();
  assert.equal(a.status, "ok"); assert.equal(a.next.title, "Lunch"); assert.equal(a.stale, false);
  await r.get(); assert.equal(calls, 1, "cached for 5 minutes");
  assert.ok(!JSON.stringify(a).includes("private-9f8e7d6c5b4a"), "the address is never in an answer");

  t += 6 * 60e3; mode = "throw";
  const b = await r.get();
  assert.equal(b.status, "ok", "a failed refresh keeps serving the last feed"); assert.equal(calls, 2);
  assert.equal(b.next.title, "Lunch");
  assert.ok(logs.length && logs.every(m => !m.includes("private-9f8e7d6c5b4a") && !m.includes("me%40example.com")), "logs have the address cut out: " + logs.join("|"));
  await r.get(); assert.equal(calls, 2, "a failure backs off for a minute");

  const fresh = createNextReader({ configFile: f, fetchImpl, now: () => t, log: (l, m) => logs.push(m) });
  const e = await fresh.get();
  assert.equal(e.status, "error"); assert.ok(!JSON.stringify(e).includes("private-9f8e7d6c5b4a"), "the error says what failed, not where: " + e.why);
  assert.match(e.why, /\[calendar address\]/);

  mode = "500"; t += 61e3;
  const f5 = await createNextReader({ configFile: f, fetchImpl, now: () => t }).get();
  assert.deepEqual([f5.status, f5.why], ["error", "calendar HTTP 500"]);

  assert.equal(scrub(`oops ${SECRET} and /ical/me%40example.com/private-9f8e7d6c5b4a/basic.ics`, SECRET), "oops [calendar address] and [calendar address]");
});

test("reader: a reply that is not a calendar is an error, not a crash", async () => {
  const dir = tmpDir("cal"), f = path.join(dir, "calendar.json");
  fs.writeFileSync(f, JSON.stringify({ ics_url: SECRET }));
  const r = createNextReader({ configFile: f, fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => "<html>sign in</html>" }), now: () => NOW });
  assert.deepEqual([(await r.get()).status, (await r.get()).why], ["error", "the address did not return a calendar"]);
});

test("hub: /api/next answers from the reader, and 'unconfigured' with the real one and no file", async () => {
  const dir = tmpDir("cal");
  const hub = await quietHub({ stateDir: dir });
  try {
    const j = JSON.parse((await raw(hub.port, "/api/next")).body);
    assert.deepEqual([j.status, j.why], ["unconfigured", "no calendar.json yet"]);
  } finally { await hub.close(); }
  const hub2 = await quietHub({ next: { get: async () => ({ status: "ok", next: { title: "X" } }), peek: () => null } });
  try { assert.equal(JSON.parse((await raw(hub2.port, "/api/next")).body).next.title, "X"); } finally { await hub2.close(); }
});
