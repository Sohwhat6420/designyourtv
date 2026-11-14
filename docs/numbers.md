# The README's numbers, and how they were made

The README carries two sets of numbers. [On the television](#on-the-television) is what one real set measured on 3 and
4 November 2026. [In a desktop browser](#in-a-desktop-browser) is what the same page measured in headless Chromium on
14 November 2026, with the raw results of both runs in [numbers-2026-11-14.json](numbers-2026-11-14.json). Nothing is
estimated, and each section says what it does not show.

## On the television

One television: a Xiaomi set on Android 11, with 1,788 MB of RAM and four cores, which Android flags as low-RAM. Its
interface is drawn at 1920 × 1080. Every reading was taken over adb on 3 or 4 November 2026 with Android's own tools
(`dumpsys gfxinfo`, `dumpsys meminfo`, `top`), plus timings of the page's main thread. These are dated readings of the builds of those days. They were not repeated for this page, they say nothing
about other televisions, and the raw logs are not in this repository.

### At rest

| Figure | How | Date |
| --- | --- | --- |
| **0 frames drawn in 10 s** | `dumpsys gfxinfo` for the app with the painting in front, night dimming on and nothing changing. | 4 Nov |
| **0.0 % CPU** for the app, 0.0 to 0.2 % for its browser process | `top`, three samples. A second reading on 4 Nov, with night on, had the app at about 1 % and the browser process under 1 %. | 3 Nov |
| **About 170 MB** of the TV's memory while it shows | The drop in available memory with the painting in front. The app itself was 140 MB (proportional set size), 70 MB of that the painting as graphics textures; at rest on a later build that day it was 133 MB. | 3 Nov |
| **5.8 MB** with an HDMI input in front | `dumpsys meminfo`: the app with no browser view alive. | 3 Nov |
| **24 steps a second** for the rain | Not a measurement. It is a constant in the page (`WX_FPS`): the rain's keyframes are stepped, so the TV has a new picture to draw 24 times a second, not 60. | in the code |

One thing the 5.8 MB figure does not cover. A build of 4 Nov kept the page alive behind streaming apps, and there the
app and its browser process together held 200 to 360 MB. The code now throws the page away when another app comes to
the front, but no labelled reading was saved after that fix, so there is no after-number to give.

### Before and after one round of fixes

All on 4 Nov 2026, on the television, with the panel dark. In that state this TV delivers a frame every 18.2 ms and
not every 16.7, so the absolute frame times are not a smoothness score: only each before against its after is a fair
reading. Frame times are from `dumpsys gfxinfo`; the painting-change and accessibility rows are time on the page's
main thread; the dock-press rows run from the press to Android receiving the request to open the app.

| What | Before | After | What changed |
| --- | ---: | ---: | --- |
| Changing the painting: main thread held reading pixels | 943 to 1,318 ms | 18 to 25 ms | The clock's mask is read from a 192 × 108 copy made ahead of time |
| Dock sliding by day: median frame | 85 ms | 25 ms | The glass shows a copy of the painting blurred ahead of time, not a live blur |
| Dock sliding by day: frames drawn in the slide | 61 | 125 | The same |
| App drawer opening by day: median frame | 57 ms | 23 ms | The same |
| Dock sliding at night: slowest frame | 282 ms | 37 to 41 ms | The same |
| Changing the painting at night: slowest frame | 568 to 804 ms | 225 to 270 ms | The small copy and the pre-blurred glass together |
| Dock press to Android having the request, Netflix already loaded | 389 ms | 231 ms | The dock hands over after 180 ms and not 340, once its colour fill covers the screen |
| The same, YouTube already loaded | 522 ms | 336 ms | The same |
| The same, iQIYI already loaded | 448 ms | 243 ms | The same |
| Accessibility bookkeeping on each painting change | 133 to 151 ms | 0 ms | The embedded browser no longer builds an accessibility tree for the wallpaper |

With every filter, blur and shadow stripped from the page, this TV still took a median 25 ms to draw a frame of the
dock. That is the set's own floor, and the frosted dock now sits on it. A painting change at night still has a slowest
frame of 225 to 270 ms: better, not solved. The time an app takes to show its first picture is mostly the app's own
start, which the dock cannot change.

### Not measured, so not claimed

- **Against Google TV's own home screen.** There is no like-for-like reading of memory, frame times or idle CPU, so
  the README says nothing about being lighter or faster than it. The one rough pair of readings that exists (13 and
  14 Nov, about eight hours apart, in different states) had this app's resident memory higher, at 187 MB against
  153 MB.
- **A frame rate.** No "frames a second" figure for the page is quoted anywhere.
- **Power.** No meter was on the plug, so there is no figure in watts for AOD mode or anything else.
- **Burn-in.** The AOD clock's steps, the matte and the dark panel are mechanisms; their effect on a panel was not
  tested.
- **Other televisions.** One set only.
- **Debloating as a speed-up.** Disabling the safe tier freed 69 MB of available memory (806 to 875 MB, 3 Nov), because
  most preinstalled extras were not running.

## In a desktop browser

Measured or counted on 14 November 2026. The demo hub (`hub/tools/demo.mjs`, sample readings, no TV) and the TV page
(`tv-setup.html?kiosk=tv`) at 1920 × 1080 in Playwright's headless Chromium 153, on a 4-core Intel Xeon cloud machine
with **no GPU**. Chromium therefore draws everything in software. The main-thread and heap figures depend little on
that; anything about drawing depends on it a great deal (see [Left out](#left-out)). None of this section was measured
on a TV.

```bash
node tools/readme-media/measure.mjs --idle 60 --changes 6 > numbers.json
```

## The table

| Figure | How |
| --- | --- |
| **164 tests in CI** | `node --test hub/test/*.test.mjs` (125 pass), `node --test tools/test/*.test.mjs` (31 pass), `node tools/tv-apply.mjs --selftest` (8 pass): the three steps of `.github/workflows/test.yml`. |
| **111 core checks** | The APK's plain-Java core and `CoreTest`, compiled with `javac --release 8` and run on a JVM, as `build-tv-apk.mjs` does before every build: `all 111 passed`. Not part of CI. |
| **0 npm dependencies** | There is no `package.json`, and every `import` in `hub/` and `tools/` is a `node:` built-in or a file in this repository. |
| **0.5 % main thread** | Chrome DevTools Protocol `Performance.getMetrics`: the change in `TaskDuration` over 60 s at rest (5 s after the last change settled), divided by 60 s. Both runs: 0.5 %. Script (`ScriptDuration`): 24 and 27.4 ms a minute. The demo's song is playing throughout, so the music card and its equaliser are on screen. |
| **< 3 MB heap** | `JSHeapUsedSize` at the end of the minute at rest: 2.6 and 2.8 MB. |
| **~5 ms to plan a change** | The page's own breakdown of each change (`window.__cost` with `?measure`: freeze, measure, write, clock), median of six changes per run: 4.9 and 5.4 ms. The change itself is Web Animations on transform and opacity. |
| **1.0 MB first load** | Every response while the page loaded, by body size: 48 requests, 1,045.7 KB. From the hub 963.2 KB in 45 requests, of which the page is 449.7 KB and the rest is paintings, their cut-outs and icons; from Google Fonts 82.5 KB in 3 requests. The hub's live event stream is left out (it never ends). |
| **10 clock faces, 4 layers** | Ten `.f-*` faces and ten face buttons in `tv-setup.html`; four files per painting in `plates/` (the painting, the foreground cut-out, the same with near clouds, the subject alone). |

## Also measured, not in the table

| What | Result | Why it is not in the README |
| --- | --- | --- |
| Wakeups at rest | 5 timeouts, 143 interval callbacks and 1 animation frame a minute (counted by wrapping `setTimeout`, `setInterval` and `requestAnimationFrame` before the page's script). The 1 s intervals (the music card's progress, the analogue hands) return at once when nothing changed. | No fair comparison was measured, so there is nothing to compare it with. |
| Style and layout at rest | 82 to 84 style recalculations and 73 layouts a minute | Same. |
| Renderer memory | 230 to 231 MB proportional set size | Mostly Chromium itself and decoded paintings; says more about the browser than the page. |
| CPU of every Chromium process at rest | 59 to 66 % of one core | Software rendering. See the equaliser below. |
| Frame times during a change | median 100 to 117 ms, p95 183 ms | Software rendering at 1920 × 1080 with no GPU: says nothing about a TV. |

**The equaliser.** With everything else the same, stopping the music card's four equaliser bars (a CSS animation)
took the whole browser at rest from 59.6 % to 4.8 % of a core on this machine (30 s each). In software rendering
every frame is drawn on the CPU, so this exaggerates it, but the bars do keep the compositor drawing every frame for
as long as a song plays. The page already stops them at night.

## Left out

- **No comparison with other screensavers or live wallpapers.** None was measured on the same machine in the same
  way, so the README makes no "faster than" or "lighter than" claim.
- **No TV in this section.** These are a desktop browser's costs. A TV's WebView, CPU and GPU differ; what one
  television measured is in [On the television](#on-the-television).
- **The hub's own CPU and memory** were not measured.

## How the media is made

Every picture of the home screen in the README is the real TV page (`tv-setup.html`) drawn by headless Chromium from
the demo hub; nothing is mocked up, redrawn or generated. The scripts are in
[`tools/readme-media/`](../tools/readme-media/).

### The lead pictures (`assets/premium/`)

`film-premium.mjs` films the page set up the way the author had his own television: his painting with its saved clock
settings, a three-stop bus card, the dock with the apps' own icons, rain in the forecast, AOD mode and the night veil.
Three things the repository does not ship are handed in from a private folder: the painting and its cut-outs, the
apps' icons (their owners' artwork), and the author's Claude Code activity for the heatmap. The bus stops and service
numbers are made up, and the calendar, batteries, limits and music are the demo hub's samples. So you can re-run the
script with your own painting and icons, but not reproduce these exact frames from a clone.

| File | How |
| --- | --- |
| `hero.jpg` | One frame at 1920 × 1080 with rain in the forecast. |
| `loop.webp` | The dock raised by an arrow press, focus walked along it, and the dock sent away, stepped through frame by frame; 1280 × 720, 3.9 MB. |
| `dock.jpg`, `dock-closeup.jpg` | The frame with the dock up, and a crop of the dock from a 2x frame. |
| `aod.jpg`, `aod.webp` | AOD mode, and the veil coming down and lifting again; the film is 3.0 MB and is linked, not shown inline. |
| `night.jpg` | Night on OK. |
| `depth-closeup.jpg` | A crop of the clock and the painting's subject from a 2x frame. |
| `card-*.png` | Each card cut from a 2x frame, with the painting behind its glass exactly as drawn. |
| `setup.jpg` | The setup page on the same painting after 5 s, its empty side margins and the thumbnail strip trimmed. |

### The drawn panels (`assets/premium/*-dark.svg`, `*-light.svg`)

Three panels are drawings, not captures: one second of screen time in three states (`idle`), before and after on the
television (`before-after`), and an idle evening's backlight (`aod-timeline`). `panels.py` builds a dark and a light
copy of each from the hand-written sources in `tools/readme-media/panels/`. It adds only what cannot be typed by
hand: the launcher's own interface face (Hanken Grotesk, SIL OFL 1.1) cut down to the letters used and embedded, the
two colour sets, the two real frames inside the timeline (scaled from `hero.jpg` and `aod.jpg`), and the AOD clock's
path, computed from the same formula the page uses. Every figure in them is in the tables above. Their motion is CSS
only, and each panel stands complete and still for anyone who has asked for reduced motion.

```bash
python tools/readme-media/panels.py
```

### The sample-painting pictures

These show the demo as a clone runs it, on the paintings the repository ships.

| File | Made by | How |
| --- | --- | --- |
| `assets/clocks.webp` | `film-stills.mjs`, `crop.py` | The same crop from each of the four sample paintings at 2x, scaled to half and set 2 × 2. |
| `docs/screens/setup.webp` | `film-stills.mjs`, `crop.py` | The setup page after 6 s, its empty side margins trimmed. |

From the earlier round, still in `assets/` and no longer shown in the README:

| File | Made by | How |
| --- | --- | --- |
| `assets/tv-loop.webp`, `.gif` | `film-loop.mjs`, `encode.py` | The two F-22 paintings in rotation (`config.loop.json`): one unfilmed lap, then a filmed lap, each change stepped through at 25 frames a second with the page's own `?measure` hooks (`__swapAt`, `__seek`), so every frame is where the real change stands at that moment. WebP at 1920 × 1080 (5.1 MB); GIF at 960 × 540 and 12.5 frames a second (6.1 MB). |
| `assets/depth-closeup.webp` | `film-stills.mjs`, `crop.py` | Raptors over Alaska at 2x (3840 × 2160), cropped between the two columns of cards. |
| `assets/widgets-*.svg` | `film-stills.mjs`, `crop.py`, `cards.py` | Each card in a 16:10 crop of a 2x frame. Around the card the same frame is softened and darkened, never removed or redrawn. The rotation is CSS only. |
| `assets/dock.webp` | `film-stills.mjs`, `crop.py` | Up sends the dock away and the first arrow press raises it again, both stepped through at 25 frames a second; the top edge is darkened a little where the crop cuts the digits and a card. |
| `assets/banner-*.png` | `banner.mjs` | A 2x frame of Raptors over Alaska, scaled, beside the title. |

In every picture the page's clock is pinned to Wednesday 11 November 2026, 10:47 in Singapore, and the demo hub's
clock starts at the same moment (`fake-now.mjs`), so the sample readings agree with it. The F-22 paintings use their
per-painting settings in `config.capture.json`; Raptors over Alaska uses the *Tinted* clock. The demo has no Claude
Code activity, so in a clone that card shows the page's own labelled sample, as it does on a TV until the hub has
data.

```bash
node tools/readme-media/film-loop.mjs --out frames/loop
python tools/readme-media/encode.py frames/loop assets/tv-loop --width 1920 --gif-width 960 --quality 74
node tools/readme-media/film-stills.mjs --out frames/stills
python tools/readme-media/crop.py frames/stills frames/slides    # also writes docs/screens/setup.webp
python tools/readme-media/cards.py frames/slides
node tools/readme-media/banner.mjs frames/stills
```

You need Node 22, Playwright with its Chromium, Python 3 with Pillow and fontTools, and ffmpeg for the GIF.
