"""Draws the placeholder plates the public copy ships with, so the page runs before you bring your own paintings.

Each plate is a painted-looking valley scene drawn from scratch (no source image), in the same four layers that
depth_pipeline.py and subj_only.py write for a real painting:
  plates/<id>.plate.webp   the whole scene, 1920x1080
  plates/<id>.fg.webp      the near hill and the tree (alpha): drawn ABOVE the clock, so the clock sits behind them
  plates/<id>.fgall.webp   the same plus the low clouds, for the 'clouds over the clock' look
  plates/<id>.subj.webp    the tree alone, for the 'depth on the subject alone' setting

Usage: python -I tools/make-placeholder.py [out dir]   (default plates/; needs Pillow and NumPy)
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

W, H = 1920, 1080
SCENES = {
    # id: sky top, sky horizon, sun, hills far to near, tree, cloud tint
    "placeholder": dict(sky=((32, 44, 86), (238, 150, 104)), sun=(255, 214, 160), hills=[(96, 84, 120), (70, 62, 98), (40, 38, 62)],
                        tree=(22, 22, 34), tree_x=0.4, cloud=(246, 184, 150), seed=7),
    "placeholder-dawn": dict(sky=((120, 168, 214), (246, 226, 196)), sun=(255, 246, 226), hills=[(150, 170, 186), (104, 132, 140), (58, 86, 82)],
                             tree=(34, 52, 46), tree_x=0.62, cloud=(255, 252, 246), seed=11),
}


def ridge(rng, base, amp, n=7):
    """A hill line: a few sine waves, y in pixels for every x."""
    x = np.arange(W) / W
    y = np.full(W, base, np.float32)
    for k in range(1, n + 1):
        y += amp / k * np.sin(2 * np.pi * (k * x + rng.random()))
    return y


def layer_mask(y_line):
    yy = np.arange(H)[:, None]
    return (yy >= y_line[None, :]).astype(np.float32)


def strokes(img, rng, n, alpha):
    """Short, soft dabs in the scene's own colours, so flat fills read as paint."""
    over = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    px = img.load()
    for _ in range(n):
        x, y = int(rng.random() * W), int(rng.random() * H)
        r, g, b = px[x, y][:3]
        j = lambda c: int(max(0, min(255, c + rng.normal(0, 10))))
        L, t = 10 + rng.random() * 34, rng.random() * np.pi
        dx, dy = np.cos(t) * L, np.sin(t) * L * 0.35
        d.line([(x - dx, y - dy), (x + dx, y + dy)], fill=(j(r), j(g), j(b), alpha), width=int(3 + rng.random() * 5))
    return Image.alpha_composite(img, over.filter(ImageFilter.GaussianBlur(0.8)))


def scene(sid, s):
    rng = np.random.default_rng(s["seed"])
    t = (np.arange(H) / (H * 0.72)).clip(0, 1)[:, None, None]
    top, hor = np.array(s["sky"][0], np.float32), np.array(s["sky"][1], np.float32)
    rgb = np.broadcast_to(top + (hor - top) * t ** 1.4, (H, W, 3)).copy()
    # the sun, low and to the right, with a wide glow
    yy, xx = np.mgrid[0:H, 0:W]
    dist = np.hypot(xx - W * 0.68, yy - H * 0.55)
    glow = np.exp(-(dist / 260) ** 2)[..., None]
    rgb = rgb + (np.array(s["sun"], np.float32) - rgb) * glow * 0.7
    rgb[dist < 70] = s["sun"]
    masks, lines = [], []
    for i, col in enumerate(s["hills"]):
        line = ridge(rng, H * (0.52 + 0.09 * i), H * (0.06 + 0.02 * i))   # the near crests reach the clock's lower part
        lines.append(line)
        m = layer_mask(line)
        shade = (1 - 0.18 * (np.arange(H)[:, None] / H))[..., None]
        rgb = rgb * (1 - m[..., None]) + np.array(col, np.float32) * shade * m[..., None]
        masks.append(m)
    near = masks[-1]
    # a lone tree on the near hill: the subject, standing where the clock's digits are so they pass behind it
    tree = Image.new("L", (W, H), 0)
    td = ImageDraw.Draw(tree)
    tx = int(W * s["tree_x"])
    ty = int(lines[-1][tx]) + 40                                       # rooted in the near hill
    td.polygon([(tx - 12, ty), (tx - 5, ty - 170), (tx + 5, ty - 170), (tx + 12, ty)], fill=255)
    cy = ty - 225                                                       # low enough to cover only the digits' lower part
    for _ in range(24):                                                 # a rounded crown of overlapping dabs
        a, d = rng.random() * 2 * np.pi, rng.random() ** 0.6 * 80
        r = 34 + rng.random() * 30
        x, y = tx + np.cos(a) * d * 1.15, cy + np.sin(a) * d * 0.8
        td.ellipse([x - r, y - r * 0.85, x + r, y + r * 0.85], fill=255)
    tm = np.asarray(tree.filter(ImageFilter.GaussianBlur(1.2)), np.float32) / 255
    rgb = rgb * (1 - tm[..., None]) + np.array(s["tree"], np.float32) * tm[..., None]
    # low clouds drifting across the clock's band
    cl = Image.new("L", (W, H), 0)
    cd = ImageDraw.Draw(cl)
    for _ in range(14):
        cx, cy = rng.random() * W, H * (0.2 + rng.random() * 0.16)
        rx, ry = 120 + rng.random() * 220, 26 + rng.random() * 30
        cd.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=int(120 + rng.random() * 90))
    cm = np.asarray(cl.filter(ImageFilter.GaussianBlur(28)), np.float32) / 255
    rgb = rgb * (1 - cm[..., None] * 0.85) + np.array(s["cloud"], np.float32) * cm[..., None] * 0.85
    plate = Image.fromarray(rgb.clip(0, 255).astype(np.uint8), "RGB").convert("RGBA")
    plate = strokes(plate, rng, 26000, 70).convert("RGB")
    base = np.asarray(plate)
    fg_a = np.maximum(near, tm)
    cut = lambda a: Image.fromarray(np.dstack([base, (a.clip(0, 1) * 255).astype(np.uint8)]), "RGBA")
    return plate, cut(fg_a), cut(np.maximum(fg_a, (cm > 0.18) * cm)), cut(tm)


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "plates")
    out.mkdir(parents=True, exist_ok=True)
    for sid, s in SCENES.items():
        plate, fg, fgall, subj = scene(sid, s)
        plate.save(out / f"{sid}.plate.webp", quality=82, method=6)
        fg.save(out / f"{sid}.fg.webp", quality=84, alpha_quality=88, method=6)
        fgall.save(out / f"{sid}.fgall.webp", quality=84, alpha_quality=88, method=6)
        subj.save(out / f"{sid}.subj.webp", quality=84, alpha_quality=90, method=6)
        print("wrote", sid)
    return 0


if __name__ == "__main__":
    sys.exit(main())
