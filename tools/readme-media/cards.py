"""The README's rotating card of the TV's glass widgets, one SVG per GitHub theme, no script: CSS only.

    python tools/readme-media/cards.py <slides dir> [<assets dir>]     (slides from crop.py)

Each slide is an unedited crop of the TV page as Chromium drew it (film-stills.mjs, crop.py); the card the slide is
about is lit, the rest of the frame dimmed. The rotation is the profile README's (github.com/Sohwhat6420/Sohwhat6420,
tools/hero.py): slides stacked, the first never fades, each new one dissolves in over the TV's 1.05 s and settles
from 1.04 while the one it covers pushes in, and the captions leave and arrive on the TV's date-line timing. The glass
panel, the sheen sweep and the rim pulse are the profile's repo cards' (koilib.glass, .rc*s, .rc*c).
"""
import base64, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from svglib import Doc, f, font, esc, write_svg  # noqa: E402

SLIDES = [  # (card, title, what it shows: from tv-setup.html and the hub's readers)
    ("calendar", "Calendar", "The month at a glance, with today ringed in the painting's own accent."),
    ("next", "Next event", "The next entry from any ICS calendar feed, counting down to it."),
    ("buses", "Bus arrivals", "Live arrivals from Singapore's LTA DataMall, smoothed so a bus never drops out for one bad reading."),
    ("batteries", "Batteries", "Phone, tablet, watch and earbuds as rings, read over adb from the phones themselves."),
    ("limits", "Claude limits", "Session and weekly use of a Claude plan, from a small headless probe at most every 10 minutes."),
    ("heatmap", "Claude Code", "Daily Claude Code activity, read from its own transcripts. Until the hub has some, the card says it is a sample."),
    ("today", "Weekly pace", "How much of the weekly limit today allows (86 %) against what is used (41 %)."),
    ("music", "Now playing", "Follows whatever the TV itself is playing, with pause and skip."),
]
PLATES = {"f22-alaska": "Raptors over Alaska", "f22-thunderhead": "F-22 against the thunderhead",
          "placeholder": "Valley at dusk", "placeholder-dawn": "Valley at dawn"}
THEMES = {  # the profile's (koilib.THEMES): type, accents and ghost glass
    "dark": dict(text="#f4f3ef", dim="#b8bcc4", faint="#8f949c", gold="#d9b77a", accent="#ffb340",
                 gBase="rgba(28,32,39,.56)", gHiA="rgba(255,255,255,.07)", gHiB="rgba(255,255,255,.01)",
                 gGlow="#ffffff", gGlowOp=0.035, gGrain="#ffffff", gGrainOp=0.05, gRing="#ffffff", gRingOp=0.15,
                 gSheen="#ffffff", gSheenOp=0.42, gShadow="#000000", gShadowOp=0.52, track="rgba(255,255,255,.14)"),
    "light": dict(text="#14161a", dim="#4c5058", faint="#5d636c", gold="#7a5612", accent="#9a4f00",
                  gBase="rgba(243,242,238,.62)", gHiA="rgba(255,255,255,.18)", gHiB="rgba(232,234,238,.24)",
                  gGlow="#ffffff", gGlowOp=0.6, gGrain="#14161a", gGrainOp=0.03, gRing="#14161a", gRingOp=0.11,
                  gSheen="#ffffff", gSheenOp=0.88, gShadow="#0a1428", gShadowOp=0.22, track="rgba(20,22,26,.12)"),
}
PAD = (16, 6, 16, 26)                       # room round the glass for its shadow (koilib.GLASS_PAD)
W, H = 1200, 513
SX, SY, SW, SH = 24, 24, 744, 465           # the slide window, 16:10
STEP = 4.2                                  # each slide's turn, s
T = dict(fade=1.05, settle=1.5, push=1.75, out=0.26, inAt=0.85, inn=0.65)   # the TV's timings (tv-setup.html T, ON_TV)
EASE = dict(dolly="cubic-bezier(.45,.05,.25,1)", settle="cubic-bezier(.22,1,.36,1)")



# --- glass(): copied verbatim from the profile's tools/koi/koilib.py (commit a5ecb7f)
def glass(doc, T, x, y, w, h, r, shadow=True, sd=9.0):
    """One ghost-glass panel: soft shadow, translucent fill, light gradient and glow, grain, top-edge sheen and a
    hairline ring. Returns the SVG; the content goes on top. Every def gets this doc's own ids."""
    k = doc.uid("gl")
    rect = 'x="%s" y="%s" width="%s" height="%s" rx="%s"' % (f(x, 2), f(y, 2), f(w, 2), f(h, 2), f(r, 2))
    doc.defs.append('<clipPath id="%sc"><rect %s/></clipPath>' % (k, rect))
    # the TV's sheen: light over the top half, gone by 48 %, then a faint shade towards the foot
    doc.defs.append('<linearGradient id="%sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="%s"/>'
                    '<stop offset=".48" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="%s"/></linearGradient>'
                    % (k, T["gHiA"], T["gHiB"]))
    doc.defs.append('<radialGradient id="%sr" gradientUnits="userSpaceOnUse" cx="%s" cy="%s" r="%s">'
                    '<stop offset="0" stop-color="%s" stop-opacity="%s"/><stop offset="1" stop-color="%s" stop-opacity="0"/>'
                    '</radialGradient>' % (k, f(x + w * 0.18, 1), f(y - h * 0.1, 1), f(max(w, h) * 0.75, 1),
                                           T["gGlow"], f(T["gGlowOp"], 3), T["gGlow"]))
    doc.defs.append('<linearGradient id="%ss" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="%s" stop-opacity="0"/>'
                    '<stop offset=".22" stop-color="%s" stop-opacity="%s"/><stop offset=".78" stop-color="%s" stop-opacity="%s"/>'
                    '<stop offset="1" stop-color="%s" stop-opacity="0"/></linearGradient>'
                    % (k, T["gSheen"], T["gSheen"], f(T["gSheenOp"], 3), T["gSheen"], f(T["gSheenOp"] * 0.55, 3), T["gSheen"]))
    # grain: static fractal noise, its red channel turned into a faint alpha
    gr, gg, gb = (int(T["gGrain"][i:i + 2], 16) / 255 for i in (1, 3, 5))
    doc.defs.append('<filter id="%sn" x="0" y="0" width="100%%" height="100%%" color-interpolation-filters="sRGB">'
                    '<feTurbulence type="fractalNoise" baseFrequency="1.15" numOctaves="2" seed="%d" stitchTiles="stitch"/>'
                    '<feColorMatrix values="0 0 0 0 %s  0 0 0 0 %s  0 0 0 0 %s  2.2 0 0 0 -.9"/></filter>'
                    % (k, len(doc.defs) % 97, f(gr, 3), f(gg, 3), f(gb, 3)))
    out = []
    if shadow:
        doc.defs.append('<filter id="%sb" x="-20%%" y="-20%%" width="140%%" height="160%%"><feGaussianBlur stdDeviation="%s"/></filter>'
                        % (k, f(sd, 2)))
        inset = min(10.0, w * 0.04)
        out.append('<rect x="%s" y="%s" width="%s" height="%s" rx="%s" fill="%s" fill-opacity="%s" filter="url(#%sb)"/>'
                   % (f(x + inset, 2), f(y + sd * 1.7, 2), f(w - 2 * inset, 2), f(h - sd * 2, 2), f(r, 2),
                      T["gShadow"], f(T["gShadowOp"], 3), k))
    out.append('<rect %s fill="%s"/>' % (rect, T["gBase"]))
    out.append('<g clip-path="url(#%sc)"><rect %s fill="url(#%sg)"/><rect %s fill="url(#%sr)"/>'
               '<rect %s opacity="%s" filter="url(#%sn)"/></g>'
               % (k, rect, k, rect, k, rect, f(T["gGrainOp"] * 1.6, 3), k))
    # the top edge catches the light: an inner line along the top, fading round the corners
    rr = max(0.0, r - 0.6)
    out.append('<path d="M%s %sa%s %s 0 0 1 %s-%sH%sa%s %s 0 0 1 %s %s" fill="none" stroke="url(#%ss)" stroke-width="1.1"/>'
               % (f(x + 0.6, 2), f(y + rr, 2), f(rr, 2), f(rr, 2), f(rr, 2), f(rr - 0.6, 2), f(x + w - rr - 0.6, 2),
                  f(rr, 2), f(rr, 2), f(rr, 2), f(rr - 0.6, 2), k))
    out.append('<rect x="%s" y="%s" width="%s" height="%s" rx="%s" fill="none" stroke="%s" stroke-opacity="%s"/>'
               % (f(x + 0.5, 2), f(y + 0.5, 2), f(w - 1, 2), f(h - 1, 2), f(max(0, r - 0.5), 2), T["gRing"], f(T["gRingOp"], 3)))
    return "".join(out)

# ----------------------------------------------------------------------------------------------
# the koi
# ----------------------------------------------------------------------------------------------
SLIM = 0.8  # body width relative to the first sketch: koi seen from above are long and slim
PROFILE = [(52, 0), (51, 3.2), (49, 6.4), (46, 9.2), (41, 12.2), (34, 14.8), (25, 16.6), (15, 17.4), (5, 17),
           (-5, 15.6), (-15, 13.4), (-25, 10.6), (-33, 8), (-40, 6), (-45, 4.8), (-48, 4.3)]




def wrap(s, key, size, width):
    lines, cur = [], ""
    for w in s.split():
        t = (cur + " " + w).strip()
        if cur and font(key).width(t, size) > width:
            lines.append(cur); cur = w
        else:
            cur = t
    return lines + [cur]


def build(theme, slides_dir):
    Th = THEMES[theme]
    meta = json.load(open(os.path.join(slides_dir, "slides.json")))
    n, cyc = len(SLIDES), len(SLIDES) * STEP
    pc = lambda t: "%s%%" % f(max(0.0, min(cyc, t)) / cyc * 100, 3)
    desc = ("The TV's glass widgets, one at a time, each shown on the painting it sits on, in real frames from the demo: "
            + " ".join("%s: %s" % (t, d) for _, t, d in SLIDES))
    doc = Doc(W, H, "designyourtv's glass widgets", desc)
    css = doc.css
    # slides
    imgs, caps = [], []
    for i, (card, title, text) in enumerate(SLIDES):
        m = meta[card]
        data = base64.b64encode(open(os.path.join(slides_dir, card + ".jpg"), "rb").read()).decode()
        cx, cy, cw, ch, cr = m["card"]
        k = SW / 1120.0
        cx, cy, cw, ch, cr = cx * k, cy * k, cw * k, ch * k, cr * k
        hole = '<rect x="%s" y="%s" width="%s" height="%s" rx="%s"/>' % (f(SX + cx - 1, 1), f(SY + cy - 1, 1), f(cw + 2, 1), f(ch + 2, 1), f(cr + 1, 1))
        doc.defs.append('<mask id="h%d"><rect x="%d" y="%d" width="%d" height="%d" fill="#fff"/>%s</mask>'
                        % (i, SX, SY, SW, SH, hole.replace("/>", ' fill="#000"/>')))
        imgs.append('<g class="s s%d"><g class="d d%d"><image href="data:image/jpeg;base64,%s" x="%d" y="%d" width="%d" height="%d" preserveAspectRatio="xMidYMid slice"/>'
                    '<rect x="%d" y="%d" width="%d" height="%d" fill="#05070a" fill-opacity=".5" mask="url(#h%d)"/>'
                    '%s</g></g>'
                    % (i, i, data, SX, SY, SW, SH, SX, SY, SW, SH, i,
                       hole.replace("/>", ' fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="1.2"/>')))
        # its caption
        # the counter, title and text, centred between the eyebrow and the painting's name
        lines = wrap(text, "h4", 18.5, 360)
        block = 104 + (len(lines) - 1) * 28
        x0, y = 806, 66 + (420 - 66 - block) / 2 - 6
        parts = []
        parts.append(doc.text("%02d / %02d" % (i + 1, n), x0, y, "h6", 12.5, Th["gold"], tracking=0.12)[0])
        parts.append(doc.text(title, x0 - 2, y + 58, "serif", 52, Th["text"])[0])
        for j, line in enumerate(lines):
            parts.append(doc.text(line, x0, y + 104 + j * 28, "h4", 18.5, Th["dim"])[0])
        parts.append(doc.text("ON " + PLATES[m["plate"]].upper(), x0, 420, "h6", 11.5, Th["faint"], tracking=0.12)[0])
        caps.append('<g class="c c%d">%s</g>' % (i, "".join(parts)))
    # the fixed eyebrow, and the progress track under the captions
    eyebrow = doc.text("GLASS WIDGETS · REAL TV FRAMES", 806, 66, "h6", 12.5, Th["gold"], tracking=0.12)[0]
    bw, gap, by = 38, 6, 452
    track = "".join('<rect x="%s" y="%d" width="%d" height="3" rx="1.5" fill="%s"/>' % (f(806 + k * (bw + gap)), by, bw, Th["track"]) for k in range(n))
    bars = "".join('<rect class="p p%d" x="%s" y="%d" width="%d" height="3" rx="1.5" fill="%s"/>' % (k, f(806 + k * (bw + gap)), by, bw, Th["accent"]) for k in range(n))

    # ---- motion (hero.py's scheme): slide i arrives at i*STEP; the last one leaves at the wrap, over slide 0
    css.append(".s{opacity:0}.s0{opacity:1}.c{opacity:0}.c0{opacity:1}.p{opacity:0}.p0{opacity:1}")
    css.append(".d{transform-box:view-box;transform-origin:%spx %spx}" % (f(SX + SW / 2), f(SY + SH / 2)))
    for i in range(n):
        a = i * STEP
        b = (i + 1) * STEP if i < n - 1 else cyc          # when the next one starts to cover it
        if i > 0 and i < n - 1:
            css.append("@keyframes o%d{0%%,%s{opacity:0}%s,%s{opacity:1}%s,100%%{opacity:0}}" % (i, pc(a), pc(a + T["fade"]), pc(b + T["fade"]), pc(b + T["fade"] + .01)))
        elif i == n - 1:
            css.append("@keyframes o%d{0%%{opacity:1}%s{opacity:0}%s{opacity:0}%s,100%%{opacity:1}}" % (i, pc(T["fade"]), pc(a), pc(a + T["fade"])))
        if i > 0:
            css.append(".s%d{animation:o%d %ss infinite;animation-timing-function:%s}" % (i, i, f(cyc), EASE["dolly"]))
        # the camera: in at a, settling from 1.04; pushed at b while the next dissolves over it
        if i == 0:
            kf = "0%%{transform:scale(1.04)}%s{transform:none}%s{transform:none}%s,100%%{transform:translate(-.3%%,-.5%%) scale(1.04)}" % (pc(T["settle"]), pc(b), pc(b + T["push"]))
        elif i < n - 1:
            kf = "0%%,%s{transform:scale(1.04)}%s{transform:none}%s{transform:none}%s,100%%{transform:translate(-.3%%,-.5%%) scale(1.04)}" % (pc(a), pc(a + T["settle"]), pc(b), pc(b + T["push"]))
        else:   # pushed at the wrap (0), back to 1.04 unseen, then in at a
            kf = "0%%{transform:none}%s{transform:translate(-.3%%,-.5%%) scale(1.04)}%s{transform:scale(1.04)}%s{transform:scale(1.04)}%s,100%%{transform:none}" % (pc(T["push"]), pc(T["push"] + .01), pc(a), pc(a + T["settle"]))
        css.append("@keyframes z%d{%s}.d%d{animation:z%d %ss infinite;animation-timing-function:%s}" % (i, kf, i, i, f(cyc), EASE["settle"]))
        # the caption: out quickly at the change, in late (the TV's date line: 260 ms out, in from 850 ms over 650 ms)
        inn = (pc(a + T["inAt"]), pc(a + T["inAt"] + T["inn"]))
        if i == 0:
            cap = "0%%,%s{opacity:0}%s{opacity:1}%s{opacity:1}%s,100%%{opacity:0}" % (inn[0], inn[1], pc(b), pc(b + T["out"]))
        else:
            cap = "0%%,%s{opacity:0}%s{opacity:1}%s{opacity:1}%s,100%%{opacity:0}" % (inn[0], inn[1], pc(b), pc(min(cyc, b + T["out"])))
        css.append("@keyframes t%d{%s}.c%d{animation:t%d %ss linear infinite}" % (i, cap, i, i, f(cyc)))
        css.append("@keyframes q%d{0%%,%s{opacity:0}%s,%s{opacity:1}%s,100%%{opacity:0}}.p%d{animation:q%d %ss linear infinite}"
                   % (i, pc(a), pc(a + .3), pc(b), pc(min(cyc, b + .3)), i, i, f(cyc)))
    # the profile repo cards' sheen and rim (rc*s, rc*c)
    css.append(".sw{animation:sw 7s ease-in-out infinite}@keyframes sw{0%,35%{transform:translateX(-120%)}65%,100%{transform:translateX(120%)}}")
    css.append(".rim{animation:rim 4.5s ease-in-out infinite}@keyframes rim{0%,100%{stroke-opacity:.35}18%{stroke-opacity:1}}")
    css.append("@media (prefers-reduced-motion: reduce){*{animation:none!important}}")
    doc.defs.append('<clipPath id="win"><rect x="%d" y="%d" width="%d" height="%d" rx="12"/></clipPath>' % (SX, SY, SW, SH))
    doc.defs.append('<linearGradient id="swg" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/>'
                    '<stop offset=".5" stop-color="#fff" stop-opacity=".09"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>')
    body = [glass(doc, Th, 1, 1, W - 2, H - 2, 18),
            '<g clip-path="url(#win)">%s<rect class="sw" x="%d" y="%d" width="%d" height="%d" fill="url(#swg)"/></g>' % ("".join(imgs), SX, SY, SW, SH),
            '<rect class="rim" x="%s" y="%s" width="%d" height="%d" rx="12" fill="none" stroke="%s" stroke-width="1"/>' % (f(SX + .5), f(SY + .5), SW - 1, SH - 1, Th["gold"]),
            eyebrow, "".join(caps), track, bars]
    doc.body.append('<g transform="translate(%d %d)">%s</g>' % (PAD[0], PAD[1], "".join(body)))
    svg = doc.render()
    vw, vh = W + PAD[0] + PAD[2], H + PAD[1] + PAD[3]
    return svg.replace('width="%d" height="%d" viewBox="0 0 %d %d"' % (W, H, W, H), 'width="%d" height="%d" viewBox="0 0 %d %d"' % (vw, vh, vw, vh), 1)


if __name__ == "__main__":
    slides = sys.argv[1]
    assets = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "assets")
    os.makedirs(assets, exist_ok=True)
    for theme in ("light", "dark"):
        p = os.path.join(assets, "widgets-%s.svg" % theme)
        with open(p, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(build(theme, slides))
        print("%s  %.0f KB" % (p, os.path.getsize(p) / 1e3))
