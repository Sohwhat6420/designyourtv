# Changelog

Dates are in Singapore time. The project is pre-1.0, so anything may change between minor versions.

## 0.1.0 (11 Nov 2026)

The first public release.

- **Depth-clock paintings.** Four layers per painting (the painting, a foreground cut-out, the same plus near clouds,
  and the subject alone), with the clock drawn between them. There are ten faces, an auto colour sampled from the
  painting, three materials, and a legibility guard that pauses depth when a foreground would hide more than 38 % of
  the digits.
- **Glass widgets.** A calendar month, the next ICS event, live bus arrivals, battery rings, plan limits, the weather
  and a music card. Every reading greys out and shows its age once it goes stale.
- **A dock you drive with the remote.** It rises on any key press.
- **The hub.** It answers LAN and loopback only, guards the Host header against DNS rebinding, streams state over SSE,
  and keeps keys and calendar addresses out of the logs.
- **The setup page**, where you choose what the TV shows for each painting.
- **`tv-apply.mjs`** makes reversible changes to a Google TV and logs each one before sending it. It has a self-test
  against an in-process fake TV.
- **`tv-guard`** decides what may run on the TV, and when.
- **A browser demo** (`node hub/tools/demo.mjs`): the real hub with sample readings, touching no adb, network or local
  state.
- **The plate walkthrough** for making your own depth paintings with two small ONNX models.
- **CI** on Windows with Node 22: the hub tests, the tv-guard tests and the tv-apply self-test.
