// Preload for the README captures only: the demo hub's clock starts at FAKE_NOW (an ISO time) and runs on from there,
// so its sample readings (the next event, the bus arrivals) agree with the page, whose clock the capture pins to the
// same moment. Nothing else changes.   FAKE_NOW=2026-11-11T10:47:00+08:00 node --import ./fake-now.mjs hub/tools/demo.mjs
const target = Date.parse(process.env.FAKE_NOW || "");
if (Number.isFinite(target)) {
  const Real = Date, off = target - Real.now();
  class FakeDate extends Real {
    constructor(...a) { if (a.length === 0) super(Real.now() + off); else super(...a); }
    static now() { return Real.now() + off; }
  }
  globalThis.Date = FakeDate;
}
