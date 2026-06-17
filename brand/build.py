#!/usr/bin/env python3
"""
Generate raster brand assets from the SVG sources.

Run from the repo root:

    python3 brand/build.py

This is intentionally a small, dependency-free PIL script — installs
where Python3 + Pillow already exist. Re-run any time mark.svg /
wordmark.svg changes; the outputs are checked into the repo so a
developer doesn't need Python on their dev machine.
"""
from __future__ import annotations

import os
import struct
import zlib
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Brand colors (espresso-dark fallback — matches the values in
# @codellyson/justui/tokens.css and the SVG `<style>` defaults).
BG = (22, 20, 18)        # canvas bg
ACCENT = (232, 161, 63)  # amber dot
TEXT = (232, 222, 210)   # body text

# ─────────────────────────────────────────────────────────────────────
# Minimal RGBA PNG writer + ICO writer so we don't need Pillow for the
# Tauri icon set + the favicon. We render the mark with a radial halo
# manually — same geometry as mark.svg.
# ─────────────────────────────────────────────────────────────────────

def write_png(path: Path, w: int, h: int, rows):
    sig = b"\x89PNG\r\n\x1a\n"

    def chunk(t, d):
        return (
            struct.pack(">I", len(d))
            + t
            + d
            + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    raw = b"".join(
        b"\x00" + b"".join(bytes(px) for px in row) for row in rows
    )
    idat = zlib.compress(raw, 9)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as f:
        f.write(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))


def render_mark(size: int, transparent_bg: bool = False):
    """Return a `size x size` grid of RGBA pixels matching mark.svg."""
    cx, cy = (size - 1) / 2.0, (size - 1) / 2.0
    # Geometry matches mark.svg's 1024² viewBox: dot=22% radius,
    # halo=38%. The halo is a quadratic falloff matching the SVG
    # radial gradient stops (0.55 → 0.18 → 0 at 0%, 45%, 100%).
    dot_r = size * (225 / 1024)
    halo_r = size * (380 / 1024)
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            dx, dy = x - cx, y - cy
            d = math.sqrt(dx * dx + dy * dy)
            # Start with bg (or transparent for favicon)
            if transparent_bg:
                r, g, b, a = 0, 0, 0, 0
            else:
                r, g, b, a = (*BG, 255)
            if d <= halo_r:
                t = d / halo_r
                # Two-stop falloff, matched to the SVG gradient
                if t <= 0.45:
                    alpha = 0.55 - (0.55 - 0.18) * (t / 0.45)
                else:
                    alpha = 0.18 - 0.18 * ((t - 0.45) / 0.55)
                if alpha > 0:
                    if transparent_bg:
                        a = max(a, int(255 * alpha))
                        r = int(r * (1 - alpha) + ACCENT[0] * alpha) if a else ACCENT[0]
                        g = int(g * (1 - alpha) + ACCENT[1] * alpha) if a else ACCENT[1]
                        b = int(b * (1 - alpha) + ACCENT[2] * alpha) if a else ACCENT[2]
                    else:
                        r = int(r + (ACCENT[0] - r) * alpha)
                        g = int(g + (ACCENT[1] - g) * alpha)
                        b = int(b + (ACCENT[2] - b) * alpha)
            if d <= dot_r:
                # One-pixel anti-alias on the edge
                edge = dot_r - d
                if edge >= 1:
                    r, g, b, a = (*ACCENT, 255)
                else:
                    mix = max(0.0, edge)
                    r = int(r + (ACCENT[0] - r) * mix)
                    g = int(g + (ACCENT[1] - g) * mix)
                    b = int(b + (ACCENT[2] - b) * mix)
                    a = max(a, int(255 * mix)) if transparent_bg else 255
            row.append((r, g, b, a))
        rows.append(row)
    return rows


def write_ico(path: Path, png_paths):
    """Write a multi-resolution ICO that embeds PNGs (Vista+ format)."""
    images = []
    for p in png_paths:
        data = p.read_bytes()
        # Use the PNG's IHDR for width/height (avoids importing PIL)
        w = struct.unpack(">I", data[16:20])[0]
        h = struct.unpack(">I", data[20:24])[0]
        images.append((min(w, 256) % 256, min(h, 256) % 256, data))
    n = len(images)
    out = struct.pack("<HHH", 0, 1, n)  # reserved, type=ICO, count
    offset = 6 + 16 * n
    entries = b""
    payloads = b""
    for w, h, data in images:
        size = len(data)
        # width, height, colorcount, reserved, planes, bpp, size, offset
        entries += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, size, offset)
        payloads += data
        offset += size
    path.write_bytes(out + entries + payloads)


# ─────────────────────────────────────────────────────────────────────
# Drive the outputs.
# ─────────────────────────────────────────────────────────────────────

def main():
    print("rendering brand assets")

    # Master raster for `tauri icon`
    master = ROOT / "brand" / "mark-1024.png"
    rows1024 = render_mark(1024, transparent_bg=False)
    write_png(master, 1024, 1024, rows1024)
    print(f"  · {master.relative_to(ROOT)}")

    # Tauri icon set (overwrites the placeholders generated in Phase 4)
    tauri_icons = ROOT / "src-tauri" / "icons"
    for name, size in [
        ("32x32.png", 32),
        ("128x128.png", 128),
        ("128x128@2x.png", 256),
        ("icon.png", 1024),
    ]:
        rows = render_mark(size)
        write_png(tauri_icons / name, size, size, rows)
        print(f"  · {(tauri_icons / name).relative_to(ROOT)}")

    # Favicons for both apps (transparent so any bg shows through)
    fav_sizes = [16, 32, 64, 256]
    favicons_tmp = []
    for s in fav_sizes:
        p = ROOT / "brand" / f"favicon-{s}.png"
        rows = render_mark(s, transparent_bg=True)
        write_png(p, s, s, rows)
        favicons_tmp.append(p)
    ico_path_src = ROOT / "brand" / "favicon.ico"
    write_ico(ico_path_src, favicons_tmp)
    print(f"  · {ico_path_src.relative_to(ROOT)}")

    for app in [ROOT / "apps" / "web" / "public", ROOT / "apps" / "marketing" / "public"]:
        app.mkdir(parents=True, exist_ok=True)
        (app / "favicon.ico").write_bytes(ico_path_src.read_bytes())
        (app / "favicon.svg").write_text((ROOT / "brand" / "mark.svg").read_text())
        # 32px PNG fallback for browsers that don't read .ico cleanly
        (app / "favicon-32.png").write_bytes((ROOT / "brand" / "favicon-32.png").read_bytes())
        print(f"  · {(app / 'favicon.{ico,svg,-32.png}').relative_to(ROOT)}")

    # Open Graph image (1200×630) — mark on the left, wordmark + tagline
    # on the right. Hand-rendered text (no TTF dependency) using simple
    # geometric letter rasterization so the script stays portable.
    og = render_og()
    og_path = ROOT / "brand" / "og.png"
    write_png(og_path, 1200, 630, og)
    print(f"  · {og_path.relative_to(ROOT)}")
    for app in [ROOT / "apps" / "web" / "public", ROOT / "apps" / "marketing" / "public"]:
        (app / "og.png").write_bytes(og_path.read_bytes())
        print(f"  · {(app / 'og.png').relative_to(ROOT)}")

    # Marketing canvas-hero illustration (SVG — theme-responsive, no
    # rasterization needed). Copy verbatim into the public/ folder so
    # the Astro page can <img src="/canvas-hero.svg" />.
    hero_src = ROOT / "brand" / "canvas-hero.svg"
    if hero_src.exists():
        (ROOT / "apps" / "marketing" / "public" / "canvas-hero.svg").write_text(
            hero_src.read_text()
        )
        print("  · apps/marketing/public/canvas-hero.svg")

    # Cleanup the temporary favicon PNGs (the .ico embeds them already)
    for p in favicons_tmp:
        if p.name != "favicon-32.png":
            p.unlink(missing_ok=True)

    print("done")


# ─────────────────────────────────────────────────────────────────────
# OG composer. Pillow + a system TTF give us proper kerned text;
# without that the wordmark looks like 8-bit-era pixel art and that
# undermines the whole brand. SF (San Francisco) is the cleanest sans
# always present on macOS; Helvetica is the fallback. Both are close
# enough to Geist (geometric humanist sans) that the card stays on-
# brand.
# ─────────────────────────────────────────────────────────────────────

OG_W, OG_H = 1200, 630

# Candidate TTF/TTC paths in priority order. macOS only — Linux/Windows
# would need their own list (or just bring-your-own via env var).
FONT_CANDIDATES = [
    "/System/Library/Fonts/SFNS.ttf",
    "/System/Library/Fonts/SFCompact.ttf",
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial.ttf",
]


def find_font():
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


def render_og():
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        print("  ! Pillow not installed; OG image will be skipped. Run `pip3 install Pillow`.")
        # Return a flat dark canvas so the build still produces a file.
        return [[(*BG, 255) for _ in range(OG_W)] for _ in range(OG_H)]

    font_path = find_font()
    if not font_path:
        print("  ! no system TTF found; skipping OG text")
        return [[(*BG, 255) for _ in range(OG_W)] for _ in range(OG_H)]

    img = Image.new("RGBA", (OG_W, OG_H), (*BG, 255))

    # Mark on the left — composited from our radial-gradient renderer
    # so the halo blends correctly against the OG bg.
    mark_size = 340
    mark_rows = render_mark(mark_size, transparent_bg=False)
    mark_img = Image.new("RGBA", (mark_size, mark_size))
    mark_img.putdata(
        [tuple(px) for row in mark_rows for px in row]
    )
    mark_x = 180
    mark_y = (OG_H - mark_size) // 2
    img.paste(mark_img, (mark_x, mark_y), mark_img)

    draw = ImageDraw.Draw(img)

    # Right side: wordmark + tagline. Sized so the tagline fits the
    # 1200px width with comfortable right padding (~80px).
    text_x = 620
    word = ImageFont.truetype(font_path, 110)
    tagline = ImageFont.truetype(font_path, 32)

    # Accent underline above the wordmark — same width as "justnotes"
    # so it reads as part of the same composition.
    word_bbox = draw.textbbox((text_x, 0), "justnotes", font=word)
    word_w = word_bbox[2] - word_bbox[0]
    underline_y = 235
    draw.rectangle(
        (text_x, underline_y, text_x + min(word_w, 460), underline_y + 6),
        fill=(*ACCENT, 255),
    )

    draw.text((text_x, underline_y + 22), "justnotes", font=word, fill=(*TEXT, 255))

    # Muted tagline
    tagline_color = (*blend(TEXT, BG, 0.45), 255)
    draw.text(
        (text_x, underline_y + 22 + word.size + 14),
        "spatial notes on a dark canvas.",
        font=tagline,
        fill=tagline_color,
    )

    # Pillow → row-of-rows for the write_png path
    pixels = list(img.getdata())
    return [pixels[y * OG_W : (y + 1) * OG_W] for y in range(OG_H)]


def blend(c1, c2, t):
    return tuple(int(c1[i] * (1 - t) + c2[i] * t) for i in range(3))


if __name__ == "__main__":
    main()
