"""Depth-effect plate builder for the TV lock screen.

For each wallpaper: crop to 16:9, find what should sit IN FRONT of the clock
(the salient subject from BiRefNet, plus everything nearer than the sky from
Depth Anything V2), pick where the clock goes so the foreground covers only its
lower part (Apple's rule), pick a clock tint from the wallpaper, and write:
  out/<id>.plate.webp   the wallpaper, 1920x1080
  out/<id>.fg.webp      the foreground cut-out (alpha), drawn above the clock
  out/<id>.fgall.webp   the same plus floating near things (clouds), for the 'clouds over the clock' look
  out/plates.json       clock box, tint and mask stats per plate

Usage: python -I depth_pipeline.py [--size WxH] <models dir> <out dir> <id>=<image>[@fy] ...
  @fy          optional vertical crop anchor for images taller than 16:9 (0 top, 0.5 centre = default, 1 bottom)
  --size WxH   output size of plate/fg/fgall (default 1920x1080; use 3840x2160 for a 4K TV).
               Blur widths and search steps scale with the size, so a 4K plate gets the same
               look and the same clock placement as the 1920 one.
  plates.json is merged: this run's ids are updated, the other ids already in it are kept.
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image

W, H = 1920, 1080
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


def cover(im, fy=0.5):
    """Scale to cover W x H, then crop. fy is the vertical anchor (0 top, 0.5 centre, 1 bottom)."""
    s = max(W / im.width, H / im.height)
    im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    x, y = (im.width - W) // 2, round((im.height - H) * fy)
    return im.crop((x, y, x + W, y + H))


def norm(arr):
    return ((arr / 255.0 - MEAN) / STD).transpose(2, 0, 1)[None].astype(np.float32)


def subject_mask(sess, rgb):
    x = norm(np.asarray(Image.fromarray(rgb).resize((1024, 1024), Image.BILINEAR), np.float32))
    y = sess.run(None, {sess.get_inputs()[0].name: x})[0][0, 0]
    y = 1 / (1 + np.exp(-y))
    return cv2.resize(y, (W, H), interpolation=cv2.INTER_LINEAR)


def depth_map(sess, rgb):
    h, w = 518, 518 * 16 // 9 // 14 * 14
    x = norm(np.asarray(Image.fromarray(rgb).resize((w, h), Image.BICUBIC), np.float32))
    d = sess.run(None, {"pixel_values": x})[0][0]
    d = cv2.resize(d, (W, H), interpolation=cv2.INTER_CUBIC)
    lo, hi = np.percentile(d, 2), np.percentile(d, 98)
    return np.clip((d - lo) / (hi - lo + 1e-6), 0, 1)  # 1 = near


def scene_mask(depth):
    # Everything clearly nearer than the far plane (sky, distant haze).
    far = np.percentile(depth[: H // 3], 30)
    t = far + 0.18
    soft = np.clip((depth - t) / 0.08 + 0.5, 0, 1)
    # Keep only scenery that rises from the bottom of the frame (land, city,
    # sea spray). Floating near things such as clouds would cover the top of
    # the digits, which the depth effect should never do.
    n, lab = cv2.connectedComponents((soft > 0.5).astype(np.uint8))
    grounded = set(np.unique(lab[-3:, :])) - {0}
    keep = np.isin(lab, list(grounded)).astype(np.float32)
    k = 2 * round(4 * W / 1920) + 1  # 9 at 1920
    keep = cv2.dilate(keep, np.ones((k, k), np.uint8))
    return soft * keep, soft


def place_clock(fg):
    """Clock box: ~58% wide, ~31% tall. Prefer centre; foreground may cover
    the lower part only, ideally ~20-30% of the glyph area."""
    bw, bh = int(W * 0.58), int(H * 0.31)
    best = None
    for cx in (W // 2, int(W * 0.36), int(W * 0.64)):
        for top in range(int(H * 0.05), int(H * 0.32), round(8 * W / 1920)):
            box = fg[top: top + bh, cx - bw // 2: cx + bw // 2]
            upper = box[: int(bh * 0.5)].mean()
            occ = box.mean()
            score = abs(occ - 0.22) + 3 * upper + (0 if cx == W // 2 else 0.06) + 0.15 * (top / H)
            if best is None or score < best[0]:
                best = (score, cx, top, occ, upper)
    _, cx, top, occ, upper = best
    return {"cx": cx / W, "top": top / H, "w": bw / W, "h": bh / H,
            "occlusion": round(float(occ), 3), "upper_occlusion": round(float(upper), 3)}


def tint(rgb, fg, c):
    x0, x1 = int((c["cx"] - c["w"] / 2) * W), int((c["cx"] + c["w"] / 2) * W)
    y0, y1 = int(c["top"] * H), int((c["top"] + c["h"]) * H)
    reg = rgb[y0:y1, x0:x1].reshape(-1, 3).astype(np.float32)
    keep = fg[y0:y1, x0:x1].reshape(-1) < 0.3
    reg = reg[keep] if keep.sum() > 500 else reg
    mean = reg.mean(0)
    lum = (0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2]) / 255
    hsv = cv2.cvtColor(np.uint8([[mean]]), cv2.COLOR_RGB2HSV)[0, 0]
    hue, sat = int(hsv[0]), min(int(hsv[1]), 90)
    if lum > 0.58:
        ink = cv2.cvtColor(np.uint8([[[hue, sat, 60]]]), cv2.COLOR_HSV2RGB)[0, 0]
        mode = "dark"
    else:
        ink = cv2.cvtColor(np.uint8([[[hue, min(sat, 40), 245]]]), cv2.COLOR_HSV2RGB)[0, 0]
        mode = "light"
    return {"ink": "#%02x%02x%02x" % tuple(int(v) for v in ink), "mode": mode, "bg_lum": round(float(lum), 3)}


def parse_size(argv):
    """Pull an optional `--size WxH` (or `--size=WxH`) out of argv; returns (w, h, rest)."""
    rest, size, i = [], (1920, 1080), 0
    while i < len(argv):
        a = argv[i]
        if a == "--size" or a.startswith("--size="):
            val = a.split("=", 1)[1] if "=" in a else argv[i + 1]
            i += 1 if "=" in a else 2
            w, h = (int(v) for v in val.lower().split("x"))
            size = (w, h)
        else:
            rest.append(a)
            i += 1
    return size[0], size[1], rest


def main():
    global W, H
    W, H, argv = parse_size(sys.argv[1:])
    models, out = Path(argv[0]), Path(argv[1])
    sigma = 1.2 * W / 1920
    out.mkdir(parents=True, exist_ok=True)
    so = ort.SessionOptions()
    so.intra_op_num_threads = 6
    seg = ort.InferenceSession(str(models / "birefnet-lite.onnx"), so, providers=["CPUExecutionProvider"])
    dep = ort.InferenceSession(str(models / "depth-anything-v2-small.onnx"), so, providers=["CPUExecutionProvider"])
    meta = []
    for arg in argv[2:]:
        pid, path = arg.split("=", 1)
        fy = 0.5
        if "@" in path:  # optional vertical crop anchor: <id>=<image>@0.9 keeps the lower part
            path, fy = path.rsplit("@", 1)
            fy = float(fy)
        plate = cover(Image.open(path).convert("RGB"), fy)
        rgb = np.asarray(plate)
        subj = subject_mask(seg, rgb)
        scene, scene_all = scene_mask(depth_map(dep, rgb))
        fg = cv2.GaussianBlur(np.maximum(subj, scene), (0, 0), sigma)
        fg_all = cv2.GaussianBlur(np.maximum(subj, scene_all), (0, 0), sigma)
        clock = place_clock(fg)
        plate.save(out / f"{pid}.plate.webp", quality=82, method=6)
        alpha = (np.clip(fg, 0, 1) * 255).astype(np.uint8)
        cut = np.dstack([rgb, alpha])
        Image.fromarray(cut, "RGBA").save(out / f"{pid}.fg.webp", quality=84, alpha_quality=88, method=6)
        cut_all = np.dstack([rgb, (np.clip(fg_all, 0, 1) * 255).astype(np.uint8)])
        Image.fromarray(cut_all, "RGBA").save(out / f"{pid}.fgall.webp", quality=84, alpha_quality=88, method=6)
        Image.fromarray((subj * 255).astype(np.uint8)).resize((480, 270)).save(out / f"{pid}.subj.png")
        Image.fromarray((scene * 255).astype(np.uint8)).resize((480, 270)).save(out / f"{pid}.scene.png")
        m = {"id": pid, "src": Path(path).name, "clock": clock, **tint(rgb, fg, clock),
             "subject_cover": round(float(subj.mean()), 3), "scene_cover": round(float(scene.mean()), 3)}
        meta.append(m)
        print(json.dumps(m), flush=True)
    # Merge into any existing plates.json: update this run's ids, keep the rest (and their order).
    path = out / "plates.json"
    old = json.loads(path.read_text()) if path.exists() else []
    new = {m["id"]: m for m in meta}
    merged = [new.pop(o["id"], o) for o in old] + list(new.values())
    path.write_text(json.dumps(merged, indent=1))


if __name__ == "__main__":
    main()
