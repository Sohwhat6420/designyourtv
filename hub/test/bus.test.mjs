import test from "node:test";
import assert from "node:assert/strict";
import { parseBusArrival, createBusReader } from "../lib/bus.mjs";

// example stops (the reader is given them; a real hub reads hub/state/bus.json)
const STOPS = [{ code: "10001", name: "Riverside Stop" }, { code: "10002", name: "Market Street" }, { code: "10003", name: "Hill Road" }];
const EXCLUDE = new Set(["169"]);

const NOW = Date.parse("2026-11-03T12:00:00+08:00");
const FIXTURE = {
  "odata.metadata": "https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival",
  BusStopCode: "10001",
  Services: [
    { ServiceNo: "169", Operator: "SBST", NextBus: { EstimatedArrival: "2026-11-03T12:02:00+08:00", Load: "SEA", Type: "SD", Monitored: 1 } },
    { ServiceNo: "858", Operator: "SMRT",
      NextBus: { EstimatedArrival: "2026-11-03T12:04:31+08:00", Load: "SDA", Type: "DD", Monitored: 1, Feature: "WAB" },
      NextBus2: { EstimatedArrival: "2026-11-03T12:15:00+08:00", Load: "SEA", Type: "SD", Monitored: 0 },
      NextBus3: { EstimatedArrival: "", Load: "", Type: "" } },
    { ServiceNo: "117", Operator: "SBST", NextBus: { EstimatedArrival: "2026-11-03T11:59:40+08:00", Load: "LSD", Type: "BD", Monitored: 1 } },
    { ServiceNo: "117M", Operator: "SBST", NextBus: { EstimatedArrival: "garbage" } },
  ],
};

test("parses services, minutes and ISO eta next to min, leaves out 169, sorts by number", () => {
  const r = parseBusArrival(JSON.stringify(FIXTURE), STOPS[0], NOW, EXCLUDE);
  assert.equal(r.code, "10001"); assert.equal(r.name, "Riverside Stop");
  assert.deepEqual(r.services.map(s => s.no), ["117", "117M", "858"]);
  const s858 = r.services.find(s => s.no === "858");
  assert.deepEqual(s858.next.map(n => n.min), [5, 15]);
  assert.deepEqual(s858.next.map(n => n.eta), ["2026-11-03T04:04:31.000Z", "2026-11-03T04:15:00.000Z"]);
  assert.deepEqual(Object.keys(s858.next[0]).slice(0, 2), ["min", "eta"], "eta sits right next to min");
  assert.equal(Date.parse(s858.next[0].eta), Date.parse("2026-11-03T12:04:31+08:00"));
  assert.deepEqual(s858.next.map(n => n.load), ["SDA", "SEA"]);
  assert.equal(s858.next[0].type, "DD");
  assert.equal(s858.next[1].monitored, false);
  assert.equal(r.services[0].next[0].min, 0, "an arrival in the past reads 0 (Arr)");
  assert.equal(r.services[0].next[0].eta, "2026-11-03T03:59:40.000Z");
  assert.deepEqual(r.services[1].next, [], "an unparseable time is skipped, not guessed");
});

test("junk bodies give an empty stop, never a throw", () => {
  assert.deepEqual(parseBusArrival("not json", STOPS[1], NOW).services, []);
  assert.deepEqual(parseBusArrival({}, STOPS[1], NOW).services, []);
});

test("the reader uses the key only in the header, caches 30 s, and keeps it out of errors", async () => {
  const KEY = "TEST-KEY-123";
  const calls = [];
  const fakeFetch = async (url, o) => {
    calls.push({ url, key: o.headers.AccountKey });
    if (url.includes("10003")) throw new Error(`boom ${KEY}`);
    return { status: 200, text: async () => JSON.stringify(FIXTURE) };
  };
  const reader = createBusReader({ fetchImpl: fakeFetch, keyReader: () => KEY, stops: STOPS, exclude: ["169"] });
  const a = await reader.get();
  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => c.key === KEY && !c.url.includes(KEY)));
  assert.equal(a.stops.length, 3);
  const bad = a.stops.find(s => s.code === "10003");
  assert.ok(bad.error && !bad.error.includes(KEY), "the key never appears in an error");
  assert.ok(!JSON.stringify(a).includes(KEY));
  await reader.get();
  assert.equal(calls.length, 3, "second read within 30 s is cached");
});

test("no key file means a clear error and no request", async () => {
  let called = false;
  const r = await createBusReader({ fetchImpl: async () => { called = true; }, keyReader: () => null, stops: STOPS }).get();
  assert.equal(called, false); assert.equal(r.error, "no LTA key file");
});

const busSlot = (iso, load = "SEA", type = "SD", monitored = 1) =>
  iso ? { EstimatedArrival: iso, Load: load, Type: type, Monitored: monitored, Feature: "WAB" } : { EstimatedArrival: "" };

const oneStopReply = (no, [a, b, c]) => JSON.stringify({
  BusStopCode: "10001",
  Services: [{ ServiceNo: no, Operator: "SBST", NextBus: busSlot(a), NextBus2: busSlot(b), NextBus3: busSlot(c) }],
});

test("smoothing: a bus that vanishes for one reading is held with recomputed min, then resumes live when it comes back", async () => {
  let t = Date.parse("2026-11-04T11:00:00+08:00");
  const replies = [
    // t = 0 s: 10 min, 19 min, 21 min
    oneStopReply("13", ["2026-11-04T11:10:00+08:00", "2026-11-04T11:19:00+08:00", "2026-11-04T11:21:00+08:00"]),
    // t = 30 s: nearest bus (11:10) vanishes; LTA shifts 11:19, 11:21, 11:30 forward
    oneStopReply("13", ["2026-11-04T11:19:00+08:00", "2026-11-04T11:21:00+08:00", "2026-11-04T11:30:00+08:00"]),
    // t = 60 s: 11:10 bus returns (now 9 min away, slightly updated GPS ETA 11:10:12)
    oneStopReply("13", ["2026-11-04T11:10:12+08:00", "2026-11-04T11:19:00+08:00", "2026-11-04T11:21:00+08:00"]),
  ];
  let step = 0;
  const reader = createBusReader({
    stops: [STOPS[0]],
    keyReader: () => "K",
    now: () => t,
    fetchImpl: async () => ({ status: 200, text: async () => replies[step++] }),
  });

  const r0 = (await reader.get()).stops[0].services[0].next;
  assert.deepEqual(r0.map(x => x.min), [10, 19, 21]);
  assert.equal(r0[0].held, undefined);
  assert.equal(r0[0].eta, "2026-11-04T03:10:00.000Z");

  // +30 s: 11:09:40 remaining = 570 s -> rounds to 10 min (or let's advance 40 s -> 560 s = 9 min to prove min is recomputed!)
  t += 40e3;
  const r1 = (await reader.get()).stops[0].services[0].next;
  assert.equal(r1.length, 3, "next stays at most 3 long");
  assert.deepEqual(r1.map(x => x.min), [9, 18, 20], "held bus recomputes min from its eta");
  assert.equal(r1[0].eta, "2026-11-04T03:10:00.000Z");
  assert.equal(r1[0].held, true);
  assert.equal(r1[1].held, undefined);
  assert.equal(r1[2].held, undefined);

  t += 30e3;
  const r2 = (await reader.get()).stops[0].services[0].next;
  assert.deepEqual(r2.map(x => x.min), [9, 18, 20]);
  assert.equal(r2[0].eta, "2026-11-04T03:10:12.000Z");
  assert.equal(r2[0].held, undefined, "once back in LTA's reply, held flag is cleared");
});

test("smoothing: a bus that vanishes and never comes back is held for at most 6 readings (3 min), then gone", async () => {
  let t = Date.parse("2026-11-04T11:00:00+08:00");
  let first = true;
  const reader = createBusReader({
    stops: [STOPS[0]],
    keyReader: () => "K",
    now: () => t,
    fetchImpl: async () => ({
      status: 200,
      text: async () => first
        ? (first = false, oneStopReply("13", ["2026-11-04T11:10:00+08:00", "2026-11-04T11:20:00+08:00"]))
        : oneStopReply("13", ["2026-11-04T11:20:00+08:00"]),
    }),
  });

  const s0 = (await reader.get()).stops[0].services[0].next;
  assert.deepEqual(s0.map(x => x.min), [10, 20]);

  // Readings 1-6 missing (+30 s ... +180 s): held, minutes recomputed from the held ETA each time
  const heldMin = [10, 9, 9, 8, 8, 7], nextMin = [20, 19, 19, 18, 18, 17];
  for (let i = 0; i < 6; i++) {
    t += 30e3;
    const s = (await reader.get()).stops[0].services[0].next;
    assert.deepEqual(s.map(x => [x.min, !!x.held]), [[heldMin[i], true], [nextMin[i], false]], `reading ${i + 1} still held`);
  }

  // Reading 7 missing (+210 s): past 6 readings / 3 min -> gone
  t += 30e3;
  const s7 = (await reader.get()).stops[0].services[0].next;
  assert.deepEqual(s7.map(x => [x.min, !!x.held]), [[17, false]]);
});

test("smoothing: wall-clock cap drops a vanished bus if more than 3 min elapsed in one step", async () => {
  let t = Date.parse("2026-11-04T11:00:00+08:00");
  let first = true;
  const reader = createBusReader({
    stops: [STOPS[0]],
    keyReader: () => "K",
    now: () => t,
    fetchImpl: async () => ({
      status: 200,
      text: async () => first
        ? (first = false, oneStopReply("13", ["2026-11-04T11:10:00+08:00", "2026-11-04T11:20:00+08:00"]))
        : oneStopReply("13", ["2026-11-04T11:20:00+08:00"]),
    }),
  });

  await reader.get();
  t += 181e3;
  const next = (await reader.get()).stops[0].services[0].next;
  assert.deepEqual(next.map(x => x.eta), ["2026-11-04T03:20:00.000Z"], "not held past 3 min");
});

test("smoothing: a bus that arrived (ETA passed or <= 60 s ahead) is never held", async () => {
  let t = Date.parse("2026-11-04T11:00:00+08:00");
  const replies = [
    // Bus A already arrived (10:59:50), Bus B is 80 s ahead (11:01:20), Bus C is 15 min ahead (11:15:00)
    oneStopReply("88", ["2026-11-04T10:59:50+08:00", "2026-11-04T11:01:20+08:00", "2026-11-04T11:15:00+08:00"]),
    // At t + 30 s (11:00:30): Bus A passed (-40 s), Bus B is only 50 s ahead (<= 60 s), both gone from LTA
    oneStopReply("88", ["2026-11-04T11:15:00+08:00"]),
  ];
  let step = 0;
  const reader = createBusReader({
    stops: [STOPS[0]],
    keyReader: () => "K",
    now: () => t,
    fetchImpl: async () => ({ status: 200, text: async () => replies[step++] }),
  });

  const first = (await reader.get()).stops[0].services[0].next;
  assert.deepEqual(first.map(x => x.min), [0, 1, 15]);

  t += 30e3;
  const second = (await reader.get()).stops[0].services[0].next;
  assert.equal(second.length, 1, "neither the arrived bus nor the <=60 s bus is held");
  assert.equal(second[0].eta, "2026-11-04T03:15:00.000Z");
  assert.equal(second[0].held, undefined);
});

test("smoothing: never lets a held bus push out a real nearer one and never invents a bus", async () => {
  let t = Date.parse("2026-11-04T11:00:00+08:00");
  const replies = [
    // Reading 0: 5 min, 10 min, 20 min; plus empty service 56
    JSON.stringify({
      BusStopCode: "10001",
      Services: [
        { ServiceNo: "13", Operator: "SBST",
          NextBus: busSlot("2026-11-04T11:05:00+08:00"),
          NextBus2: busSlot("2026-11-04T11:10:00+08:00"),
          NextBus3: busSlot("2026-11-04T11:20:00+08:00") },
        { ServiceNo: "56", Operator: "SBST", NextBus: busSlot(""), NextBus2: busSlot(""), NextBus3: busSlot("") },
      ],
    }),
    // Reading 1 (+30 s): a nearer real bus appears at 11:02:30, pushing 11:20:00 off LTA's 3-slot list;
    // also 11:05:00 shifts GPS slightly to 11:05:45 (must update in place, not duplicate).
    JSON.stringify({
      BusStopCode: "10001",
      Services: [
        { ServiceNo: "13", Operator: "SBST",
          NextBus: busSlot("2026-11-04T11:02:30+08:00"),
          NextBus2: busSlot("2026-11-04T11:05:45+08:00"),
          NextBus3: busSlot("2026-11-04T11:10:00+08:00") },
        { ServiceNo: "56", Operator: "SBST", NextBus: busSlot(""), NextBus2: busSlot(""), NextBus3: busSlot("") },
      ],
    }),
  ];
  let step = 0;
  const reader = createBusReader({
    stops: [STOPS[0]],
    keyReader: () => "K",
    now: () => t,
    fetchImpl: async () => ({ status: 200, text: async () => replies[step++] }),
  });

  await reader.get();
  t += 30e3;
  const svcs = (await reader.get()).stops[0].services;
  const s13 = svcs.find(s => s.no === "13");
  const s56 = svcs.find(s => s.no === "56");
  assert.deepEqual(s13.next.map(x => x.eta), [
    "2026-11-04T03:02:30.000Z",
    "2026-11-04T03:05:45.000Z",
    "2026-11-04T03:10:00.000Z",
  ], "all three real nearer buses are kept in ETA order; held 11:20 does not push any out, and 11:05->11:05:45 does not duplicate");
  assert.ok(s13.next.every(x => x.held === undefined));
  assert.deepEqual(s56.next, [], "never invents a bus for an empty service");
});

test("smoothing finding 1: unmatched previous bus is not held when fresh bus lies within MATCH_MS (reviewer failing input)", async () => {
  let t = Date.parse("2026-11-04T11:00:00+08:00");
  const replies = [
    // Reading 1: [11:10:00, 11:11:00, 11:25:00]
    oneStopReply("13", ["2026-11-04T11:10:00+08:00", "2026-11-04T11:11:00+08:00", "2026-11-04T11:25:00+08:00"]),
    // Reading 2 (+30 s): bus A drifts by 50 s (to 11:10:50) while bus B vanishes -> [11:10:50, 11:25:00]
    oneStopReply("13", ["2026-11-04T11:10:50+08:00", "2026-11-04T11:25:00+08:00"]),
  ];
  let step = 0;
  const reader = createBusReader({
    stops: [STOPS[0]],
    keyReader: () => "K",
    now: () => t,
    fetchImpl: async () => ({ status: 200, text: async () => replies[step++] }),
  });

  const r0 = (await reader.get()).stops[0].services[0].next;
  assert.equal(r0.length, 3);

  t += 30e3;
  const r1 = (await reader.get()).stops[0].services[0].next;
  assert.equal(r1.length, 2, "asserts exactly two buses and no held one");
  assert.deepEqual(r1.map(x => x.eta), [
    "2026-11-04T03:10:50.000Z",
    "2026-11-04T03:25:00.000Z",
  ]);
  assert.ok(r1.every(x => x.held === undefined), "no held bus invented");
});

test("smoothing finding 1 mirror case: A vanishes while B drifts closer", async () => {
  let t = Date.parse("2026-11-04T11:00:00+08:00");
  const replies = [
    // Reading 1: [11:10:00, 11:11:00, 11:25:00]
    oneStopReply("13", ["2026-11-04T11:10:00+08:00", "2026-11-04T11:11:00+08:00", "2026-11-04T11:25:00+08:00"]),
    // Reading 2 (+30 s): bus A vanishes while bus B drifts to 11:10:40 -> [11:10:40, 11:25:00]
    oneStopReply("13", ["2026-11-04T11:10:40+08:00", "2026-11-04T11:25:00+08:00"]),
  ];
  let step = 0;
  const reader = createBusReader({
    stops: [STOPS[0]],
    keyReader: () => "K",
    now: () => t,
    fetchImpl: async () => ({ status: 200, text: async () => replies[step++] }),
  });

  await reader.get();
  t += 30e3;
  const r1 = (await reader.get()).stops[0].services[0].next;
  assert.equal(r1.length, 2, "asserts exactly two buses and no held one");
  assert.deepEqual(r1.map(x => x.eta), [
    "2026-11-04T03:10:40.000Z",
    "2026-11-04T03:25:00.000Z",
  ]);
  assert.ok(r1.every(x => x.held === undefined), "no held bus invented");
});

test("smoothing finding 2: holds only buses whose last reading was monitored (GPS)", async () => {
  let t = Date.parse("2026-11-04T11:00:00+08:00");
  const replies = [
    // Reading 1: Bus 1 is monitored (1), Bus 2 is unmonitored scheduled (0)
    JSON.stringify({
      BusStopCode: "10001",
      Services: [{
        ServiceNo: "13",
        Operator: "SBST",
        NextBus: busSlot("2026-11-04T11:10:00+08:00", "SEA", "SD", 1),
        NextBus2: busSlot("2026-11-04T11:20:00+08:00", "SEA", "SD", 0),
        NextBus3: busSlot(""),
      }],
    }),
    // Reading 2 (+30 s): Both vanish from LTA; LTA returns empty next
    JSON.stringify({
      BusStopCode: "10001",
      Services: [{
        ServiceNo: "13",
        Operator: "SBST",
        NextBus: busSlot(""),
        NextBus2: busSlot(""),
        NextBus3: busSlot(""),
      }],
    }),
  ];
  let step = 0;
  const reader = createBusReader({
    stops: [STOPS[0]],
    keyReader: () => "K",
    now: () => t,
    fetchImpl: async () => ({ status: 200, text: async () => replies[step++] }),
  });

  const r0 = (await reader.get()).stops[0].services[0].next;
  assert.equal(r0.length, 2);
  assert.equal(r0[0].monitored, true);
  assert.equal(r0[1].monitored, false);

  t += 30e3;
  const r1 = (await reader.get()).stops[0].services[0].next;
  assert.equal(r1.length, 1, "only the monitored bus is held; unmonitored scheduled bus is dropped");
  assert.equal(r1[0].eta, "2026-11-04T03:10:00.000Z");
  assert.equal(r1[0].held, true);
  assert.equal(r1[0].monitored, true);
});

test("smoothing: a held bus with an eta 61 s ahead computes min of 1", async () => {
  let t = Date.parse("2026-11-04T11:00:00+08:00");
  const replies = [
    // Reading 1 (t = 11:00:00): bus arrives at 11:02:00 (120 s ahead)
    oneStopReply("13", ["2026-11-04T11:02:00+08:00"]),
    // Reading 2 (t = 11:00:59): bus vanished from LTA; 61 s remain
    oneStopReply("13", []),
  ];
  let step = 0;
  const reader = createBusReader({
    stops: [STOPS[0]],
    keyReader: () => "K",
    now: () => t,
    fetchImpl: async () => ({ status: 200, text: async () => replies[step++] }),
  });

  await reader.get();
  t += 59e3; // 11:00:59 -> 61 s ahead of 11:02:00
  const r1 = (await reader.get()).stops[0].services[0].next;
  assert.equal(r1.length, 1);
  assert.equal(r1[0].held, true);
  assert.equal(r1[0].min, 1, "61 s ahead yields min 1");
});

test("smoothing: stop that errors for multiple readings and recovers drops stale items past 3 min wall-clock cap", async () => {
  let t = Date.parse("2026-11-04T11:00:00+08:00");
  let step = 0;
  const reader = createBusReader({
    stops: [STOPS[0]],
    keyReader: () => "K",
    now: () => t,
    fetchImpl: async () => {
      step++;
      if (step === 1) return { status: 200, text: async () => oneStopReply("13", ["2026-11-04T11:15:00+08:00"]) };
      if (step === 2 || step === 3) throw new Error("LTA connection lost");
      // Recovery after > 90 s from step 1
      return { status: 200, text: async () => oneStopReply("13", []) };
    },
  });

  // Step 1: t = 0
  const r1 = (await reader.get()).stops[0].services[0].next;
  assert.equal(r1.length, 1);

  // Step 2: t = +30 s, error
  t += 30e3;
  const r2 = (await reader.get()).stops[0];
  assert.ok(r2.error);

  // Step 3: t = +60 s, error
  t += 30e3;
  const r3 = (await reader.get()).stops[0];
  assert.ok(r3.error);

  // Step 4: t = +190 s (> 3 min wall clock since t = 0), recovery with empty reply
  t += 130e3;
  const r4 = (await reader.get()).stops[0].services;
  const s13 = r4.find(s => s.no === "13");
  assert.deepEqual(s13 ? s13.next : [], [], "stale held bus does not resurface after 3 min wall-clock cap");
});

test("smoothing: leftover unmatched previous and fresh buses pair within wider window (180 s) under heavy ETA drift without holding phantom", async () => {
  let t = Date.parse("2026-11-04T11:00:00+08:00");
  const replies = [
    // Reading 1: 1st bus at 11:04:00 (4 min), 2nd at 11:18:00 (18 min), 3rd at 11:34:00 (34 min)
    oneStopReply("57", ["2026-11-04T11:04:00+08:00", "2026-11-04T11:18:00+08:00", "2026-11-04T11:34:00+08:00"]),
    // Reading 2 (+51 s): 1st bus ETA jumps to 11:01:51 (drift of 129 s > MATCH_MS 120 s); 2nd and 3rd drift by 9 s
    oneStopReply("57", ["2026-11-04T11:01:51+08:00", "2026-11-04T11:17:51+08:00", "2026-11-04T11:33:51+08:00"]),
  ];
  let step = 0;
  const reader = createBusReader({
    stops: [STOPS[0]],
    keyReader: () => "K",
    now: () => t,
    fetchImpl: async () => ({ status: 200, text: async () => replies[step++] }),
  });

  const r0 = (await reader.get()).stops[0].services.find(s => s.no === "57").next;
  assert.equal(r0.length, 3);
  assert.deepEqual(r0.map(x => x.min), [4, 18, 34]);

  t += 51e3;
  const r1 = (await reader.get()).stops[0].services.find(s => s.no === "57").next;
  assert.equal(r1.length, 3, "asserts exactly three fresh buses and no phantom held bus");
  assert.deepEqual(r1.map(x => x.min), [1, 17, 33]);
  assert.ok(r1.every(x => x.held === undefined), "no held bus invented");
});
