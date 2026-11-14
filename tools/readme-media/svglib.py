"""Outlined text and a small SVG document builder, copied from the profile README's tools/svglib.py
(github.com/Sohwhat6420/Sohwhat6420, commit a5ecb7f) with its font table cut to the faces used here.

Every letter is drawn as a vector path, so the SVGs need no fonts and fetch nothing at render time
(GitHub serves README images as <img>, which may not load web fonts or anything else from inside them).
Fonts, all SIL OFL 1.1 (licences beside them in fonts/):
  Hanken Grotesk       the TV's interface face, for every label
  Instrument Serif     the TV's serif clock face
  JetBrains Mono       small numerals
"""
import os

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FONT_DIR = os.path.join(HERE, "fonts")


def f(v, nd=1):
    s = ("%." + str(nd) + "f") % v
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    if s in ("-0", ""):
        s = "0"
    return s


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


# ----------------------------------------------------------------------------------------------
# fonts: outlined glyphs shared through <defs>, laid out with GPOS pair kerning
# ----------------------------------------------------------------------------------------------
class Font:
    def __init__(self, key, filename):
        self.key = key
        self.tt = TTFont(os.path.join(FONT_DIR, filename))
        self.gs = self.tt.getGlyphSet()
        self.cmap = self.tt.getBestCmap()
        self.upm = self.tt["head"].unitsPerEm
        self.hmtx = self.tt["hmtx"]
        os2 = self.tt["OS/2"]
        self.cap = getattr(os2, "sCapHeight", 0) or int(self.upm * 0.7)
        hh = self.tt["hhea"]
        self.asc, self.desc = hh.ascent, -hh.descent      # what Chrome lays a line out with (checked against the TV page)
        self._paths = {}
        self._pair = {}
        self._class = []
        self._load_kern()

    def _load_kern(self):
        if "GPOS" not in self.tt:
            return
        gpos = self.tt["GPOS"].table
        idx = set()
        for fr in gpos.FeatureList.FeatureRecord:
            if fr.FeatureTag == "kern":
                idx.update(fr.Feature.LookupListIndex)
        for li in sorted(idx):
            lk = gpos.LookupList.Lookup[li]
            for st in lk.SubTable:
                if lk.LookupType == 9:
                    st = st.ExtSubTable
                if getattr(st, "LookupType", 2) != 2:
                    continue
                cov = st.Coverage.glyphs
                if st.Format == 1:
                    for g1, ps in zip(cov, st.PairSet):
                        for rec in ps.PairValueRecord:
                            v = getattr(rec.Value1, "XAdvance", 0) if rec.Value1 else 0
                            self._pair.setdefault((g1, rec.SecondGlyph), v or 0)
                elif st.Format == 2:
                    self._class.append((set(cov), st.ClassDef1.classDefs, st.ClassDef2.classDefs, st.Class1Record))

    def kern(self, a, b):
        if (a, b) in self._pair:
            return self._pair[(a, b)]
        for cov, cd1, cd2, recs in self._class:
            if a in cov:
                v = recs[cd1.get(a, 0)].Class2Record[cd2.get(b, 0)].Value1
                return (getattr(v, "XAdvance", 0) or 0) if v else 0
        return 0

    def glyph(self, ch):
        g = self.cmap.get(ord(ch))
        if g is None:
            raise KeyError("glyph missing for %r in %s" % (ch, self.key))
        return g

    def adv(self, g):
        return self.hmtx[g][0]

    def path(self, g):
        if g not in self._paths:
            pen = SVGPathPen(self.gs, ntos=lambda v: f(v, 0))
            self.gs[g].draw(pen)
            self._paths[g] = pen.getCommands()
        return self._paths[g]

    def layout(self, s, size, tracking=0.0):
        """Return [(glyph, x_in_font_units)], width_px. tracking is in em."""
        gl = [self.glyph(c) for c in s]
        tr = tracking * self.upm
        xs, cur = [], 0.0
        for i, g in enumerate(gl):
            xs.append(cur)
            cur += self.adv(g) + tr
            if i + 1 < len(gl):
                cur += self.kern(g, gl[i + 1])
        width = (cur - tr) * size / self.upm if gl else 0
        return list(zip(gl, xs)), width

    def width(self, s, size, tracking=0.0):
        return self.layout(s, size, tracking)[1]

    def baseline(self, top, size, lh):
        """The baseline of a CSS line box starting at `top`, `lh` px tall, in this font at `size` px (half-leading split)."""
        a, d = self.asc * size / self.upm, self.desc * size / self.upm
        return top + (lh - (a + d)) / 2 + a

    def bounds(self, g):
        from fontTools.pens.boundsPen import BoundsPen
        bp = BoundsPen(self.gs)
        self.gs[g].draw(bp)
        return bp.bounds


FONTS = {}
FILES = {
    "mono": "JetBrainsMono-Regular.ttf",
    "monob": "JetBrainsMono-Bold.ttf",
    "serif": "InstrumentSerif-Regular.ttf",            # the TV's .f-serif clock face, Instrument Serif 400
    # the TV's interface face (--ui: Hanken Grotesk), at the four weights its widgets use
    "h4": "HankenGrotesk-Regular.ttf",
    "h5": "HankenGrotesk-Medium.ttf",
    "h6": "HankenGrotesk-SemiBold.ttf",
    "h7": "HankenGrotesk-Bold.ttf",
}


def font(key):
    if key not in FONTS:
        FONTS[key] = Font(key, FILES[key])
    return FONTS[key]


class Doc:
    """Collects defs (glyphs, gradients, images) and the CSS for one SVG."""

    def __init__(self, w, h, title, desc=""):
        self.w, self.h = w, h
        self.title, self.desc = title, desc
        self.defs = []
        self.glyphs = {}
        self.css = []
        self.body = []
        self._n = 0

    def uid(self, p="i"):
        self._n += 1
        return "%s%d" % (p, self._n)

    def gid(self, fnt, g):
        k = (fnt.key, g)
        if k not in self.glyphs:
            self.glyphs[k] = "%s%d" % (fnt.key[0] + fnt.key[-1], len(self.glyphs))
        return self.glyphs[k]

    def text(self, s, x, y, key, size, fill, tracking=0.0, anchor="start", cls=None, opacity=None, sy=1.0):
        """Outlined text with its baseline at y. sy stretches it vertically (the TV clock's "stretch")."""
        fnt = font(key)
        gl, width = fnt.layout(s, size, tracking)
        if anchor == "end":
            x -= width
        elif anchor == "middle":
            x -= width / 2
        sc = size / fnt.upm
        uses = "".join('<use href="#%s" x="%s"/>' % (self.gid(fnt, g), f(gx, 0)) for g, gx in gl if fnt.path(g))
        attrs = ' fill="%s"' % fill if fill else ""
        if cls:
            attrs += ' class="%s"' % cls
        if opacity is not None:
            attrs += ' opacity="%s"' % f(opacity, 2)
        inner = '<g transform="translate(%s %s) scale(%s %s)">%s</g>' % (f(x, 2), f(y, 2), f(sc, 5), f(-sc * sy, 5), uses)
        return '<g%s>%s</g>' % (attrs, inner), width

    def letters(self, s, x, y, key, size, tracking=0.0, sy=1.0, cls="ch"):
        """One group per letter, so each can move on its own. Returns ([(svg, x0, x1)], width)."""
        fnt = font(key)
        gl, width = fnt.layout(s, size, tracking)
        sc = size / fnt.upm
        out = []
        for i, (g, gx) in enumerate(gl):
            if not fnt.path(g):
                continue
            px = x + gx * sc
            out.append(('<g class="%s %s%d"><use href="#%s" transform="translate(%s %s) scale(%s %s)"/></g>'
                        % (cls, cls, i, self.gid(fnt, g), f(px, 2), f(y, 2), f(sc, 5), f(-sc * sy, 5)),
                        px, px + fnt.adv(g) * sc))
        return out, width

    def render(self):
        glyph_defs = "".join('<path id="%s" d="%s"/>' % (gid, font(key).path(g)) for (key, g), gid in self.glyphs.items())
        out = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d" role="img" aria-labelledby="t d">'
               % (self.w, self.h, self.w, self.h),
               '<title id="t">%s</title><desc id="d">%s</desc>' % (esc(self.title), esc(self.desc)),
               "<style><![CDATA[\n%s\n]]></style>" % "\n".join(self.css),
               "<defs>%s%s</defs>" % (glyph_defs, "".join(self.defs)),
               "".join(self.body),
               "</svg>"]
        return "\n".join(out)


def write_svg(path, doc):
    path = os.path.abspath(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(doc.render())
    return path, os.path.getsize(path)
