#!/usr/bin/env python3
"""Builds the README's drawn panels (assets/premium/*.svg) from the hand-written sources in panels/.

A source is a plain SVG that opens in any browser. This script only does what cannot be typed by hand:
  /*@FONTS*/                 the launcher's own interface face (Hanken Grotesk, SIL OFL 1.1), cut down to the letters the
                             panel uses and embedded as a data: URI. GitHub shows README pictures through <img>, where an
                             SVG may not fetch a font, so it has to travel inside the file.
  /*@TOKENS*/ ... /*@END*/   the colour tokens. The source carries the dark set; a light copy is written beside it.
  @IMG(file,width,quality)   a real capture from assets/premium/, scaled and embedded as a data: URI.
  <!--@AOD_PATH-->           the always-on clock's path, from the page's own formula (tv-setup.html, paintAodClock).
  /*@AOD_STEPS*/             the keyframes that step a dot along that path.
Nothing here draws the launcher: every launcher picture is a capture, only scaled.

  python tools/readme-media/panels.py            # writes assets/premium/<name>-dark.svg, -light.svg (or <name>.svg)
You need Python 3 with Pillow and fontTools.
"""
import base64
import io
import math
import os
import re
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(HERE, "panels")
OUT = os.path.join(ROOT, "assets", "premium")
FONTS = os.path.join(HERE, "fonts")

# One accent: the sodium amber of the runway lamps in the Concorde painting (and of the bus card's "SEATS FULL").
# Contrast against GitHub's page: dark #EBA24A on #0d1117 is 8.8:1; light #A85F0F on #ffffff is 4.9:1.
THEMES = {
    "dark": "svg{--ink:#E6EDF3;--ink2:#9198A1;--rule:#30363D;--mark:#7D8590;--acc:#EBA24A;--accink:#10141F}",
    "light": "svg{--ink:#1F2328;--ink2:#59636E;--rule:#D1D9E0;--mark:#7D8590;--acc:#A85F0F;--accink:#FFFFFF}",
}
# name: does it need a light and a dark copy (it has text or lines on the page's own background)?
PANELS = {"idle": True, "before-after": True, "aod-timeline": True}
WEIGHTS = {400: "HankenGrotesk-Regular.ttf", 600: "HankenGrotesk-SemiBold.ttf"}

# the page's constants (tv-setup.html: AOD_PATH, AOD_SHIFT_MS)
AOD = {"rx": 22, "ry": 14, "px": 37, "py": 23, "step_min": 4}


def fonts_css(text):
    """@font-face rules for the letters in `text` only."""
    chars = sorted({c for c in text if ord(c) >= 32})
    out = []
    for weight, filename in WEIGHTS.items():
        tt = TTFont(os.path.join(FONTS, filename))
        opts = subset.Options()
        opts.layout_features = ["kern", "tnum"]
        opts.name_IDs = []
        opts.notdef_outline = True
        sub = subset.Subsetter(opts)
        sub.populate(unicodes=[ord(c) for c in chars])
        sub.subset(tt)
        buf = io.BytesIO()
        tt.save(buf)
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        out.append('@font-face{font-family:"HG";font-weight:%d;src:url(data:font/ttf;base64,%s) format("truetype")}' % (weight, b64))
    return "\n".join(out)


def visible_text(svg):
    """The characters the panel's <text> elements use (title and desc are not drawn)."""
    body = re.sub(r"<(title|desc|style)\b.*?</\1>", "", svg, flags=re.S)
    found = re.findall(r"<text\b[^>]*>(.*?)</text>", body, flags=re.S)
    s = re.sub(r"<[^>]+>", "", " ".join(found))
    return s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">") + " 0123456789"


def image_uri(match):
    name, width, quality = match.group(1), int(match.group(2)), int(match.group(3))
    im = Image.open(os.path.join(OUT, name)).convert("RGB")
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def aod_points(hours=3):
    """Where the clock stands after each step, as the page computes it, for `hours` hours."""
    pts = []
    for i in range(hours * 60 // AOD["step_min"] + 1):
        m = i * AOD["step_min"]
        x = AOD["rx"] * math.sin(2 * math.pi * m / AOD["px"])
        y = AOD["ry"] * math.sin(2 * math.pi * m / AOD["py"] + 1)
        pts.append((x, y))
    return pts


def aod_path(scale):
    pts = aod_points()
    line = " ".join("%.1f,%.1f" % (x * scale, y * scale) for x, y in pts)
    dots = "".join('<circle class="pd" cx="%.1f" cy="%.1f" r="2.6"/>' % (x * scale, y * scale) for x, y in pts)
    return '<polyline class="pl" points="%s"/>%s' % (line, dots)


def aod_steps(scale):
    pts = aod_points()
    n = len(pts)
    frames = []
    for i, (x, y) in enumerate(pts):
        frames.append("%.3f%%{transform:translate(%.1fpx,%.1fpx)}" % (100 * i / n, x * scale, y * scale))
    return "@keyframes aodstep{%s}" % "".join(frames)


def build(name, themed):
    src = open(os.path.join(SRC, name + ".svg"), encoding="utf-8").read()
    m = re.search(r'data-path-scale="([\d.]+)"', src)
    if m:
        scale = float(m.group(1))
        src = src.replace("<!--@AOD_PATH-->", aod_path(scale)).replace("/*@AOD_STEPS*/", aod_steps(scale))
    src = src.replace("/*@FONTS*/", fonts_css(visible_text(src)))
    src = re.sub(r"@IMG\(([^,]+),(\d+),(\d+)\)", image_uri, src)
    written = []
    for theme, tokens in (THEMES.items() if themed else [("", THEMES["dark"])]):
        out = re.sub(r"/\*@TOKENS\*/.*?/\*@END\*/", tokens, src, flags=re.S)
        path = os.path.join(OUT, name + ("-" + theme if theme else "") + ".svg")
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(out)
        written.append("%s (%.0f KB)" % (os.path.relpath(path, ROOT).replace(os.sep, "/"), os.path.getsize(path) / 1024))
    return written


if __name__ == "__main__":
    only = sys.argv[1:]
    for panel, themed in PANELS.items():
        if only and panel not in only:
            continue
        for line in build(panel, themed):
            print("wrote", line)
