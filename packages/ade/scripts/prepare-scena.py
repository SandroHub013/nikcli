#!/usr/bin/env python3
"""
Prepares the reference artwork for ADE splash screen.
Quantizes scena-sinistra.png to a deterministic 256-color palette without dithering.
Output: packages/ade/src/splash/art/scena.png
"""

import sys
import os
from PIL import Image

def prepare_scena(src_path: str, dst_path: str) -> None:
    if not os.path.exists(src_path):
        raise FileNotFoundError(f"Source image not found: {src_path}")

    os.makedirs(os.path.dirname(os.path.abspath(dst_path)), exist_ok=True)

    im = Image.open(src_path).convert("RGB")
    if im.size != (1672, 941):
        raise ValueError(f"Expected image size (1672, 941), got {im.size}")

    # Quantize to 256 colors deterministically without dithering
    quantized = im.quantize(colors=256, dither=Image.Dither.NONE)
    quantized.save(dst_path, format="PNG", optimize=True)

    size = os.path.getsize(dst_path)
    print(f"Prepared scena: {quantized.size}, 256 colors, {size} bytes ({size / 1024:.1f} KB)")
    print(f"Output: {dst_path}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python prepare-scena.py <path_to_scena-sinistra.png> [<output_path>]")
        sys.exit(1)

    src = sys.argv[1]
    default_dst = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "src", "splash", "art", "scena.png")
    )
    dst = sys.argv[2] if len(sys.argv) > 2 else default_dst

    prepare_scena(src, dst)
