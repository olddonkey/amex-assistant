#!/usr/bin/env python3
"""Generate the extension's PNG icons.

A brand-neutral mark: a rounded indigo square with a white "+" — echoing the
in-page launcher pill without borrowing American Express's blue/logo. Rendered
at 4x and downscaled with LANCZOS so the 16px icon stays crisp.

Usage: python3 build/make-icons.py [output_dir]
Default output_dir: extension/icons
"""

import os
import sys

from PIL import Image, ImageDraw

# Neutral indigo, deliberately distinct from Amex blue (#006FCF) to avoid
# implying any affiliation.
BG = (79, 70, 229, 255)   # #4F46E5
FG = (255, 255, 255, 255)  # white plus

SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 4


def make_icon(size: int) -> Image.Image:
    s = size * SUPERSAMPLE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded-square background.
    radius = round(s * 0.22)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=BG)

    # Plus sign: two rounded bars, centered.
    arm = s * 0.52          # total length of each bar
    thick = s * 0.145       # bar thickness
    cap = thick / 2         # rounded-cap radius
    cx = cy = s / 2
    half_arm = arm / 2

    # Horizontal bar.
    d.rounded_rectangle(
        [cx - half_arm, cy - thick / 2, cx + half_arm, cy + thick / 2],
        radius=cap, fill=FG)
    # Vertical bar.
    d.rounded_rectangle(
        [cx - thick / 2, cy - half_arm, cx + thick / 2, cy + half_arm],
        radius=cap, fill=FG)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(__file__), "..", "extension", "icons")
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    for size in SIZES:
        path = os.path.join(out_dir, f"icon-{size}.png")
        make_icon(size).save(path)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
