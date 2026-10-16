"""Build the app icons from the shared facet pattern (src/brand/mesh.json).

Same family as the sla and ins app icons: slate facets, white glyph. The glyph
here is an isometric cube (a 3D part). Run from the repo root:

    python scripts/build_icons.py

Writes public/icons/{icon-192,icon-512,icon-512-maskable,apple-touch-icon,favicon-32}.png
"""
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
MESH = json.loads((ROOT / "src" / "brand" / "mesh.json").read_text())
OUT = ROOT / "public" / "icons"
SS = 4  # supersample, then downscale for anti-aliasing

# The pattern is a wide band (about 3.8 : 1). A square slice of it keeps the
# facets in proportion; LIFT brightens the facet colours (the band is tuned
# dark for white header text).
BAND_ASPECT = 3.8
X0 = 0.30
X1 = X0 + 1 / BAND_ASPECT
LIFT = 0.35


def hex_rgb(c):
    return tuple(int(c[i:i + 2], 16) for i in (1, 3, 5))


def lift(rgb, t=LIFT):
    return tuple(round(v + (235 - v) * t * (v / 255) ** 0.5 + 18 * t) for v in rgb)


def draw_mesh(d, size):
    d.rectangle([0, 0, size, size], fill=lift(hex_rgb(MESH["bg"])))
    for fill, flat in MESH["polys"]:
        pts = [((flat[i] - X0) / (X1 - X0) * size, flat[i + 1] * size) for i in range(0, len(flat), 2)]
        d.polygon(pts, fill=lift(hex_rgb(fill)), outline=lift(hex_rgb(fill)))


def draw_cube(d, cx, cy, r, width):
    """Isometric cube outline: hexagon plus the three edges meeting at the front corner."""
    hexagon = [(cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a))) for a in range(-90, 270, 60)]
    d.line(hexagon + [hexagon[0]], fill="white", width=width, joint="curve")
    for k in (1, 3, 5):
        d.line([(cx, cy), hexagon[k]], fill="white", width=width)
    for p in hexagon + [(cx, cy)]:
        rr = width / 2
        d.ellipse([p[0] - rr, p[1] - rr, p[0] + rr, p[1] + rr], fill="white")


def icon(size, glyph_frac):
    S = size * SS
    img = Image.new("RGBA", (S, S))
    d = ImageDraw.Draw(img, "RGBA")
    draw_mesh(d, S)
    r = S * glyph_frac / 2
    # top face lightly tinted so the cube reads at 48 px
    tint = Image.new("RGBA", (S, S))
    hexagon = [(S / 2 + r * math.cos(math.radians(a)), S / 2 + r * math.sin(math.radians(a))) for a in range(-90, 270, 60)]
    ImageDraw.Draw(tint).polygon([hexagon[0], hexagon[1], (S / 2, S / 2), hexagon[5]], fill=(255, 255, 255, 60))
    img = Image.alpha_composite(img, tint)
    draw_cube(ImageDraw.Draw(img), S / 2, S / 2, r, max(2, round(S * 0.05)))
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    icon(192, 0.62).save(OUT / "icon-192.png")
    icon(512, 0.62).save(OUT / "icon-512.png")
    icon(512, 0.46).save(OUT / "icon-512-maskable.png")  # glyph inside the 80 % safe zone
    icon(180, 0.60).convert("RGB").save(OUT / "apple-touch-icon.png")
    icon(32, 0.78).save(OUT / "favicon-32.png")
    print("icons written to", OUT)
