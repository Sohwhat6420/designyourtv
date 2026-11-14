# The README's numbers, and how they were made

Everything in the README's [By the numbers](../README.md#by-the-numbers) table was measured or counted on 14 November
2026 on the `readme-showpiece-2026-11-14` branch. Nothing is estimated. The raw results of both measuring runs are in
[numbers-2026-11-14.json](numbers-2026-11-14.json).

## Where they were measured

The demo hub (`hub/tools/demo.mjs`, sample readings, no TV) and the TV page (`tv-setup.html?kiosk=tv`) at 1920 × 1080
in Playwright's headless Chromium 153, on a 4-core Intel Xeon cloud machine with **no GPU**. Chromium therefore draws
everything in software. The main-thread and heap figures depend little on that; anything about drawing depends on it a
great deal (see [Left out](#left-out)). None of it was measured on a TV.

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
- **No numbers from a TV.** These are a desktop browser's costs. A TV's WebView, CPU and GPU differ.
- **The hub's own CPU and memory** were not measured.

## How the media is made

Every picture and film in the README is the real TV page drawn by headless Chromium from the demo hub; nothing is
mocked up or generated. The scripts are in [`tools/readme-media/`](../tools/readme-media/):

| File | Made by | How |
| --- | --- | --- |
| `assets/tv-loop.webp`, `.gif` | `film-loop.mjs`, `encode.py` | The two F-22 paintings in rotation (`config.loop.json`): one unfilmed lap, then a filmed lap, each change stepped through at 25 frames a second with the page's own `?measure` hooks (`__swapAt`, `__seek`), so every frame is where the real change stands at that moment. WebP at 1920 × 1080 (5.1 MB); GIF at 960 × 540 and 12.5 frames a second (6.1 MB). |
| `assets/depth-closeup.webp` | `film-stills.mjs`, `crop.py` | Raptors over Alaska at 2x (3840 × 2160), cropped between the two columns of cards. |
| `assets/clocks.webp` | `film-stills.mjs`, `crop.py` | The same crop from each of the four paintings at 2x, scaled to half and set 2 × 2. |
| `assets/widgets-*.svg` | `film-stills.mjs`, `crop.py`, `cards.py` | Each card in a 16:10 crop of a 2x frame. Around the card the same frame is softened and darkened, never removed or redrawn. The rotation is CSS only, on the profile README's scheme. |
| `assets/dock.webp` | `film-stills.mjs`, `crop.py` | Up sends the dock away and the first arrow press raises it again, both stepped through at 25 frames a second; the top edge is darkened a little where the crop cuts the digits and a card. |
| `docs/screens/setup.webp` | `film-stills.mjs`, `crop.py` | The setup page after 6 s, its empty side margins trimmed. |
| `assets/banner-*.png` | `banner.mjs` | A 2x frame of Raptors over Alaska, scaled, beside the title. |

The page's clock is pinned to Wednesday 11 November 2026, 10:47 in Singapore, and the demo hub's clock starts at the
same moment (`fake-now.mjs`), so the sample readings agree with it. The F-22 paintings use their per-painting settings
in `config.capture.json`; Raptors over Alaska uses the *Tinted* clock. The demo has no Claude Code activity, so that
card shows the page's own labelled sample, as it does on a TV until the hub has data.

```bash
node tools/readme-media/film-loop.mjs --out frames/loop
python tools/readme-media/encode.py frames/loop assets/tv-loop --width 1920 --gif-width 960 --quality 74
node tools/readme-media/film-stills.mjs --out frames/stills
python tools/readme-media/crop.py frames/stills frames/slides    # also writes docs/screens/setup.webp
python tools/readme-media/cards.py frames/slides
node tools/readme-media/banner.mjs frames/stills
```

You need Node 22, Playwright with its Chromium, Python 3 with Pillow and fontTools, and ffmpeg for the GIF.
