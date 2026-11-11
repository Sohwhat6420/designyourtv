# Contributing

Thanks for looking. designyourtv has been run on one Google TV, so reports from other TVs, and new paintings, are the
most useful things you can send.

## Try it first

You don't need a TV for most changes:

```bash
node hub/tools/demo.mjs
```

Then open <http://127.0.0.1:8790/tv-setup.html?kiosk=tv> (the TV view; press an arrow key for the dock) or
<http://127.0.0.1:8790/tv-setup.html> (the setup page).

## Running the tests

These need Node 22 and nothing else. They are what CI runs on every push:

```bash
node --test hub/test/*.test.mjs
node --test tools/test/*.test.mjs
node tools/tv-apply.mjs --selftest
```

The APK's core logic has its own JVM test (`node tools/build-tv-apk.mjs --test-only`, with `JAVA_HOME` set to JDK 17).

## Reporting a TV

Open an issue with:

- the TV or streamer model, the Android TV or Google TV version, and the launcher;
- what worked (the lock screen, the dock, the Home button, casting after `tv-apply`) and what didn't.

**Never paste an IP address, an adb serial, an API key, a calendar URL or a log with your device names in it.**
Replace them with placeholders first.

## Pull requests

- Keep them small and focused, with a one-line reason in the title.
- New widget readers need a test in `hub/test/`, and a stale state that greys out and shows its age. Never show a
  made-up value for a reading the hub doesn't have.
- Anything that changes a TV setting goes through `tv-apply.mjs`. It must be reversible, logged before it is sent and
  covered by the self-test, and it must never touch a device that isn't the TV.
- Paintings you add must be your own work or openly licensed, with the licence noted next to the plate.
- British English in docs and UI copy.

## Good first issues

Look for the [`good first issue`](https://github.com/Sohwhat6420/designyourtv/labels/good%20first%20issue) label, and
ask in the issue if anything is unclear.
