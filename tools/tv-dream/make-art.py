"""Draws the TV banners and icons for the designyourtv APK into tools/tv-dream/res/drawable-xhdpi/.

Run: python -I tools/tv-dream/make-art.py [plate-id]   (Pillow; fonts from C:/Windows/Fonts; the plate from plates/,
default "placeholder", made by tools/make-placeholder.py). The Claude tile uses icons/laptop-claude.png when you have
it, else a plain monogram. Android TV banners are 320 x 180 px in drawable-xhdpi; icons 96 x 96 px.
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.normpath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(HERE, "res", "drawable-xhdpi")
FONTS = "C:/Windows/Fonts"
S = 4  # supersample
PLATE = sys.argv[1] if len(sys.argv) > 1 else "placeholder"


def font(name, px):
    return ImageFont.truetype(os.path.join(FONTS, name), px)


def wallpaper_banner():
    w, h = 320 * S, 180 * S
    plate = Image.open(os.path.join(PROJECT, "plates", PLATE + ".plate.webp")).convert("RGB").resize((w, h), Image.LANCZOS)
    fg = Image.open(os.path.join(PROJECT, "plates", PLATE + ".fg.webp")).convert("RGBA").resize((w, h), Image.LANCZOS)
    img = plate.convert("RGBA")
    # the clock sits behind the mountains, as on the TV: plate, then the time, then the foreground cut-out
    t = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(t)
    f = font("segoeuisl.ttf", 92 * S)
    text = "10:08"
    bw = d.textlength(text, font=f)
    d.text(((w - bw) / 2, h * 0.02), text, font=f, fill=(246, 249, 255, 255))
    shadow = t.getchannel("A").filter(ImageFilter.GaussianBlur(6 * S)).point(lambda a: a * 0.45)
    img = Image.composite(Image.new("RGBA", (w, h), (10, 20, 40, 255)), img, shadow)
    img = Image.alpha_composite(img, t)
    img = Image.alpha_composite(img, fg)
    # a soft scrim for the label
    scrim = Image.new("L", (w, h), 0)
    sd = ImageDraw.Draw(scrim)
    for y in range(h):
        sd.line([(0, y), (w, y)], fill=int(max(0, (y - h * 0.55) / (h * 0.45)) * 150))
    img = Image.composite(Image.new("RGBA", (w, h), (0, 0, 0, 255)), img, scrim)
    d = ImageDraw.Draw(img)
    d.text((14 * S, h - 30 * S), "Wallpaper", font=font("segoeuisl.ttf", 17 * S), fill=(240, 240, 240, 255))
    return img.resize((320, 180), Image.LANCZOS).convert("RGB")


def claude_mark(size):
    own = os.path.join(PROJECT, "icons", "laptop-claude.png")
    if os.path.exists(own):
        return Image.open(own).convert("RGBA").resize((size, size), Image.LANCZOS)
    m = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(m)
    d.ellipse([0, 0, size - 1, size - 1], fill=(217, 119, 87, 255))
    f = font("georgia.ttf", int(size * 0.62))
    tw = d.textlength("C", font=f)
    d.text(((size - tw) / 2, size * 0.12), "C", font=f, fill=(250, 246, 240, 255))
    return m


def claude_banner():
    w, h = 320 * S, 180 * S
    img = Image.new("RGBA", (w, h), (31, 30, 29, 255))
    # a faint warm glow behind the mark
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([w * 0.06, h * 0.08, w * 0.50, h * 0.92], fill=(217, 119, 87, 46))
    img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(28 * S)))
    mark = claude_mark(74 * S)
    img.alpha_composite(mark, (int(w * 0.28 - mark.width / 2), int(h / 2 - mark.height / 2)))
    d = ImageDraw.Draw(img)
    f = font("georgia.ttf", 40 * S)
    d.text((int(w * 0.47), int(h / 2 - 27 * S)), "Claude", font=f, fill=(240, 236, 228, 255))
    d.text((int(w * 0.475), int(h / 2 + 22 * S)), "large layout", font=font("segoeuisl.ttf", 13 * S), fill=(176, 170, 160, 255))
    return img.resize((320, 180), Image.LANCZOS).convert("RGB")


def icon(kind):
    n = 96 * S
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if kind == "claude":
        d.rounded_rectangle([0, 0, n - 1, n - 1], radius=22 * S, fill=(31, 30, 29, 255))
        m = claude_mark(60 * S)
        img.alpha_composite(m, ((n - m.width) // 2, (n - m.height) // 2))
    else:
        plate = Image.open(os.path.join(PROJECT, "plates", PLATE + ".plate.webp")).convert("RGBA")
        side = min(plate.size)
        plate = plate.crop(((plate.width - side) // 2, 0, (plate.width + side) // 2, side)).resize((n, n), Image.LANCZOS)
        mask = Image.new("L", (n, n), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, n - 1, n - 1], radius=22 * S, fill=255)
        img.paste(plate, (0, 0), mask)
    return img.resize((96, 96), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    wallpaper_banner().save(os.path.join(OUT, "banner.png"), optimize=True)
    claude_banner().save(os.path.join(OUT, "banner_claude.png"), optimize=True)
    icon("wall").save(os.path.join(OUT, "icon.png"), optimize=True)
    icon("claude").save(os.path.join(OUT, "icon_claude.png"), optimize=True)
    for f in sorted(os.listdir(OUT)):
        print(f, os.path.getsize(os.path.join(OUT, f)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
