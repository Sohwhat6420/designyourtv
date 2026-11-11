# Make your own plate

A plate is one painting cut into the layers the clock slots between, made from any landscape image on your own
computer's CPU.

| File | What it is | Drawn |
| --- | --- | --- |
| `plates/<id>.plate.webp` | the painting, 1920 × 1080 | under the clock |
| `plates/<id>.fg.webp` | the subject and the ground nearer than the sky (alpha) | over the clock |
| `plates/<id>.fgall.webp` | the same plus near clouds, for the *clouds over the clock* look | over the clock |
| `plates/<id>.subj.webp` | the subject alone, for *depth on the subject alone* and for framing on narrower screens | over the clock |

`tools/make-placeholder.py` draws the two placeholder plates the repo ships with, so you can see each layer before
making your own.

## 1. Pick an image

Landscape, at least 1920 px wide, with a clear subject and sky above it: a ship on the sea, a plane in the clouds, a
car on a mountain road. The clock is pinned high and centred, so a subject in the lower half that rises a little into
the middle works best: it covers the lower part of the digits and leaves them readable. Use images you have the right
to use; plates are git-ignored, so nothing you add here is published.

## 2. Get the two models (once)

Both run on the CPU through ONNX Runtime. Put them in `models/` (git-ignored) under these names:

| Save as | Model | Download | Licence |
| --- | --- | --- | --- |
| `models/birefnet-lite.onnx` | BiRefNet general lite, the subject mask (224 MB) | [rembg's release](https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx) | MIT |
| `models/depth-anything-v2-small.onnx` | Depth Anything V2 Small, what is nearer than the sky (99 MB) | [onnx-community on Hugging Face](https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx) | Apache 2.0 |

```bash
python -m pip install numpy opencv-python onnxruntime pillow
```

## 3. Cut the layers

```bash
python -I tools/depth_pipeline.py models plates harbour=~/Pictures/harbour.jpg
python -I tools/subj_only.py . harbour
```

`harbour` is the plate id: lower case, digits and hyphens. Several `id=image` pairs can go in one run. If the image
is taller than 16:9, add `@0.3` after the path to crop nearer the top (`0` top, `0.5` centre, `1` bottom). For a 4K
TV add `--size 3840x2160` and write to `plates-4k/` instead; the laptops use those files when their screens are wider
than 1920 physical pixels. The run also writes `plates/plates.json` with the clock box and a tint sampled from the
painting.

## 4. Add it to the page

One line in the `PLATES` array near the top of `tv-setup.html`'s script:

```js
{id:"harbour", name:"Harbour at noon", mine:true, ink:"#2b2f33", mode:"dark", face:"serif"},
```

- `ink` is the clock colour (take the tint from `plates.json`), and `mode` is `"dark"` when that ink is dark (a bright
  painting) and `"light"` when it is light.
- `face` is where the setup page starts: `condensed`, `tall`, `thin`, `serif`, `fat`, `rounded`, `wide`, `didone`,
  `soft` or `mono`.
- `sugg` (optional) gives the painting its own starting settings, for example `sugg:{flip:true}` to mirror it so the
  subject clears the widgets, or `sugg:{place:"center", orient:"stack", depth:"off"}`.

Reload the setup page: the painting is in the filmstrip, Not decided. Tune it, press Keep, and every screen picks it
up.

## 5. Check the cut

Open the painting in the setup page, switch *Depth* between *subject + clouds*, *subject + ground*, *subject alone*
and *off*, and look at the clock's edges. A soft or ragged mask shows as a halo; the usual fixes are a different crop
(`@fy`) or a cleaner source image. If the subject hides too much of the digits, the page pauses depth for that
painting on its own; *Width* or *Size* usually brings it back.
