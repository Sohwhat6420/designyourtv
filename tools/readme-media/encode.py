"""Encodes film-loop.mjs's frames into the README's loop: an animated WebP and a GIF fallback, each kept under a size cap.

    python tools/readme-media/encode.py <frames dir> <out stem> [--width 1280] [--gif-width 960] [--quality 72] [--cap-mb 8]

Hold frames keep their length (frames.json); every change frame is 1/fps s. The GIF goes through ffmpeg's palettegen
and paletteuse (one palette for the whole loop, ordered dithering, which compresses far better than error diffusion), which needs ffmpeg on the PATH.
"""
import json, os, subprocess, sys, tempfile
from PIL import Image

def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default

src, stem = sys.argv[1], sys.argv[2]
W, GW, Q, CAP = int(arg("--width", 1280)), int(arg("--gif-width", 960)), int(arg("--quality", 72)), float(arg("--cap-mb", 8))
GSTEP = int(arg("--gif-every", 2))      # the GIF keeps every n-th change frame (each then lasts n times as long)
meta = json.load(open(os.path.join(src, "frames.json")))
frames = meta["frames"]
size = lambda w: (w, round(w * 9 / 16))

# WebP: Pillow's animation encoder stores only what changed between frames
ims = [Image.open(os.path.join(src, f["f"])).convert("RGB").resize(size(W), Image.LANCZOS) for f in frames]
ims[0].save(stem + ".webp", save_all=True, append_images=ims[1:], duration=[f["ms"] for f in frames], loop=0,
            quality=Q, method=6, allow_mixed=False)
print("%s.webp  %d x %d  %.2f MB" % (stem, *size(W), os.path.getsize(stem + ".webp") / 1e6))

# GIF: a concat list keeps each frame's own length; holds always stay, change frames are thinned to every GSTEP-th
gframes, k = [], 0
for f in frames:
    if f["ms"] > 200 or k % GSTEP == 0: gframes.append(dict(f, ms=f["ms"] if f["ms"] > 200 else f["ms"] * GSTEP))
    k = 0 if f["ms"] > 200 else k + 1
with tempfile.TemporaryDirectory() as tmp:
    lst = os.path.join(tmp, "list.txt")
    with open(lst, "w") as fh:
        for f in gframes:
            fh.write("file '%s'\nduration %.3f\n" % (os.path.join(os.path.abspath(src), f["f"]), f["ms"] / 1000))
        fh.write("file '%s'\n" % os.path.join(os.path.abspath(src), frames[-1]["f"]))
    w, h = size(GW)
    flt = ("scale=%d:%d:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];"
           "[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" % (w, h))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-filter_complex", flt,
                    "-loop", "0", stem + ".gif"], check=True)
print("%s.gif   %d x %d  %.2f MB" % (stem, w, h, os.path.getsize(stem + ".gif") / 1e6))
for ext in ("webp", "gif"):
    mb = os.path.getsize(stem + "." + ext) / 1e6
    if mb > CAP:
        sys.exit("%s.%s is %.2f MB, over the %.1f MB cap" % (stem, ext, mb, CAP))
