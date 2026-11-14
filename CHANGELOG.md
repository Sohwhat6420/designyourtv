# Changelog

Dates are in Singapore time. The project is pre-1.0, so anything may change between minor versions.

## 0.2.0 (14 Nov 2026)

First-run fixes: what a clean install on a Google TV runs into, reproduced against a fake TV and fixed.

- **Installs no longer refused on a fresh TV.** The guard refused an install over TV Settings (where turning on
  debugging leaves you), over the Android TV launcher, and every evening, because the time gate was one household's
  viewing hours in Singapore time. Installs now go out over the home screen and TV Settings; quiet hours are off by
  default and set per household (`TV_GUARD_QUIET_HOURS`, `TV_GUARD_TZ` or `devices/tv-guard.json`).
- **Refusals say what to do.** "Press Home on the remote", "press any button so the home screen shows", or check
  `adb devices`.
- **`tv-apply --first-run`** does the whole install in one logged, undoable run: the app and its grants, the music
  card's reader (it was never allowed, so the card could not follow the TV), and the screensaver chosen and switched
  on (`screensaver_enabled` was missing from the steps).
- **Home takeover is opt-in.** The app switched its accessibility service on by itself after an install, a
  reboot or an update, and undid your removal of it. It now does so only after `tv-apply --home-key on`, which merges
  with any services you already have; `--home-key off` hands Home back for good.
- **`build-tv-apk.mjs` runs on macOS and Linux** (it named Windows `.exe` and `.bat` tools), says which SDK piece is
  missing, and only warns about memory unless `TV_BUILD_MEMORY_GATE` is set.
- **The hub prints the `--hub` address to build with,** and on Windows the firewall hint.
- **Tests:** a first run against a fake TV over a fake adb with the real guard (`tools/test/first-run.test.mjs`),
  quiet hours, the setup screens, and `--first-run` and `--home-key` undo round trips in the self-test.
- **README:** a new hero, a four-step install that matches the tools, and an "If something is off" table.

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
