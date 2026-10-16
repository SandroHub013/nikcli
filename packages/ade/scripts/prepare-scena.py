#!/usr/bin/env python3
"""
Prepares the reference artwork for ADE splash screen.
Optimizes scena-sinistra.png as truecolor RGB PNG with lossless DEFLATE compression,
preserving 100% color fidelity across all zones (olive oil, ragù, Code reflections, laptop/garlic).

Environment requirements:
- Python 3.10+ (tested with Python 3.12.3)
- Pillow 10.0+ (tested with Pillow 10.4.0)

Usage:
    python -I packages/ade/scripts/prepare-scena.py <path_to_scena-sinistra.png> [<output_path>]

Output:
    packages/ade/src/splash/art/scena.png (~1.24 MB, truecolor RGB)
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

    # Save as optimized truecolor RGB PNG with maximum lossless compression
    im.save(dst_path, format="PNG", optimize=True, compress_level=9)

    size = os.path.getsize(dst_path)
    print(f"Prepared scena: {im.size}, truecolor RGB, {size} bytes ({size / 1024:.1f} KB)")
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
