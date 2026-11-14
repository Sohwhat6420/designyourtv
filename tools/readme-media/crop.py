"""Cuts film-stills.mjs's frames into the README's files. Every pixel is the TV page as Chromium drew it; this only
crops, scales and encodes.

    python tools/readme-media/crop.py <stills dir> <slides dir> [<assets dir>]

  assets/depth-closeup.webp   the clock and the nearer jet on Raptors over Alaska, from the 2x frame (1980 x 1114)
  assets/clocks.webp          the four paintings' clocks, 2 x 2, from the 2x frames
  assets/dock.webp            the dock up over F-22 against the thunderhead, sliding away, and rising again (25 fps)
  docs/screens/setup.webp     the setup page, its empty side margins trimmed
  <slides>/<card>.jpg         each card in a 16:10 window of the painting it sits on, for cards.py; slides.json
                              holds where the card is in its window
"""
import json, os, sys
from PIL import Image

src, slides = sys.argv[1], sys.argv[2]
assets = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(__file__), "..", "..", "assets")
os.makedirs(slides, exist_ok=True); os.makedirs(assets, exist_ok=True)
meta = json.load(open(os.path.join(src, "stills.json")))
W, H = 1920, 1080

# the depth close-up: 1x box (470, 85)-(1460, 642), between the card columns, with room above the digits; 2x frame
im = Image.open(os.path.join(src, "rest-f22-alaska.png")).convert("RGB")
im.crop((940, 170, 2920, 1284)).save(os.path.join(assets, "depth-closeup.webp"), quality=92, method=6)

# the four clocks: the same box on each painting, 2 x 2 with clear gaps
tiles = [Image.open(os.path.join(src, "rest-%s.png" % p)).convert("RGB").crop((940, 170, 2920, 1284)).resize((960, 540), Image.LANCZOS)
         for p in ("f22-alaska", "f22-thunderhead", "placeholder", "placeholder-dawn")]
G = 16
grid = Image.new("RGBA", (960 * 2 + G, 540 * 2 + G), (0, 0, 0, 0))
for k, t in enumerate(tiles):
    grid.paste(t, ((k % 2) * (960 + G), (k // 2) * (540 + G)))
grid.save(os.path.join(assets, "clocks.webp"), quality=88, method=6)

# the setup page, without its empty side margins
docs = os.path.join(assets, "..", "docs", "screens")
if os.path.exists(os.path.join(src, "setup.png")) and os.path.isdir(docs):
    Image.open(os.path.join(src, "setup.png")).convert("RGB").crop((200, 0, 1720, 1080)).save(os.path.join(docs, "setup.webp"), quality=88, method=6)

# the dock: the region it and the music card move through, starting on the dock up (the first frame is the still
# a page shows before it plays); the top edge fades a little, as it cuts through the digits and the pace card
box = (520, 600, 1830, 1080)
d = [(x["f"], x["ms"]) for x in meta["dock"]]
up = d.index(("dock-up.png", 2400))
seq = d[up:] + [("dock-000.png", 1400)] + d[1:up]
fade = Image.linear_gradient("L").resize((box[2] - box[0], box[3] - box[1]))      # 0 at the top, 255 at the bottom
fade = fade.point(lambda v: 255 - max(0, int(150 * (1 - v / 255 * (box[3] - box[1]) / 110))))
shade = Image.new("RGB", fade.size, (8, 9, 12))
frames = [Image.composite(Image.open(os.path.join(src, f)).convert("RGB").crop(box), shade, fade) for f, _ in seq]
frames[0].save(os.path.join(assets, "dock.webp"), save_all=True, append_images=frames[1:], duration=[ms for _, ms in seq],
               loop=0, quality=82, method=6)

# the cards: which painting each one is shown on (two each, so the glass shows four palettes)
ON = {"calendar": "f22-thunderhead", "next": "f22-alaska", "buses": "placeholder", "batteries": "placeholder-dawn",
      "limits": "f22-alaska", "heatmap": "placeholder", "today": "f22-thunderhead", "music": "placeholder-dawn"}
OUT_W = 1120                                        # each slide, 16:10; the 2x frame gives it about 1.8 px per CSS px
out = {}
for card, plate in ON.items():
    x, y, w, h, r = meta["rest"][plate][card]
    ww = max(620.0, w + 120); wh = ww / 1.6
    cx, cy = x + w / 2, y + h / 2
    x0 = min(max(0.0, cx - ww / 2), W - ww); y0 = min(max(0.0, cy - wh / 2), H - wh)
    k = OUT_W / ww
    im = Image.open(os.path.join(src, "rest-%s.png" % plate)).convert("RGB")
    im.crop(tuple(round(v * 2) for v in (x0, y0, x0 + ww, y0 + wh))).resize((OUT_W, round(OUT_W / 1.6)), Image.LANCZOS) \
      .save(os.path.join(slides, card + ".jpg"), quality=84, optimize=True, progressive=True)
    out[card] = {"plate": plate, "card": [round((x - x0) * k, 1), round((y - y0) * k, 1), round(w * k, 1), round(h * k, 1), round(r * k, 1)]}
json.dump(out, open(os.path.join(slides, "slides.json"), "w"), indent=1)
for f in ("depth-closeup.webp", "clocks.webp", "dock.webp"):
    print("%-20s %.0f KB" % (f, os.path.getsize(os.path.join(assets, f)) / 1e3))
print("slides:", ", ".join("%s %.0f KB" % (c, os.path.getsize(os.path.join(slides, c + ".jpg")) / 1e3) for c in ON))
