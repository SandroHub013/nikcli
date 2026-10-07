"""
Draws the two pictures the Windows installer shows, from the app icon alone.

    python src-tauri/icons/nsis/make.py

sidebar.bmp (164x314) is the left panel of the welcome and finish pages,
header.bmp (150x57) the top-right corner of every other page; both 24-bit BMP,
the only format NSIS's Modern UI takes. They carry the mark and nothing else,
on purpose: the name lives in brand.json and is not baked into pixels, so a
rename does not need new pictures. Needs Pillow (`pip install pillow`); run
again only when the icon changes.
"""
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
ICON = HERE.parent / "icon.png"
BACKGROUND = (0, 0, 0)  # the dark the pixel pot is drawn for, so its square does not show


def place(canvas: Image.Image, size: int, x: int, y: int) -> None:
    # The icon is pixel art (a 32 px drawing at 16x): whole factors of it, no interpolation.
    mark = Image.open(ICON).convert("RGBA").resize((size, size), Image.NEAREST)
    canvas.paste(mark, (x, y), mark)


sidebar = Image.new("RGB", (164, 314), BACKGROUND)
place(sidebar, 128, 18, 93)
sidebar.save(HERE / "sidebar.bmp", "BMP")

header = Image.new("RGB", (150, 57), BACKGROUND)
place(header, 32, 104, 12)
header.save(HERE / "header.bmp", "BMP")
print("sidebar.bmp 164x314, header.bmp 150x57")
