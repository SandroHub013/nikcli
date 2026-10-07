"""
The Ragu Code app icons, release and ADE Test, from the pixel pot: icon-16.png and icon-32.png of the logo
generator (ade-team/design/ragu-code/gen/logo.mjs), scaled by whole factors with no interpolation.

    python make-ragu.py [folder with icon-16.png and icon-32.png]

Run from this folder; then `python nsis/make.py` for the installer pictures. Needs Pillow.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Favorites" / "ade-team" / "design" / "ragu-code" / "out"
I16 = Image.open(SRC / "icon-16.png").convert("RGBA")
I32 = Image.open(SRC / "icon-32.png").convert("RGBA")


def pot(size: int) -> Image.Image:
    """The pot on a transparent square of `size`: the 16 px drawing below 32, else the 32 px one, at the largest whole factor."""
    src = I16 if size < 32 else I32
    k = max(1, size // src.width)
    art = src.resize((src.width * k, src.height * k), Image.NEAREST)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(art, ((size - art.width) // 2, (size - art.height) // 2), art)
    return out


def release() -> None:
    for name, size in [
        ("32x32.png", 32), ("64x64.png", 64), ("128x128.png", 128), ("128x128@2x.png", 256), ("icon.png", 512),
        ("Square30x30Logo.png", 30), ("Square44x44Logo.png", 44), ("Square71x71Logo.png", 71), ("Square89x89Logo.png", 89),
        ("Square107x107Logo.png", 107), ("Square142x142Logo.png", 142), ("Square150x150Logo.png", 150),
        ("Square284x284Logo.png", 284), ("Square310x310Logo.png", 310), ("StoreLogo.png", 50),
    ]:
        pot(size).save(name)
    sizes = [16, 24, 32, 48, 64, 256]
    pot(256).save("icon.ico", sizes=[(s, s) for s in sizes], append_images=[pot(s) for s in sizes])
    pot(512).save("icon.icns")


def test() -> None:
    """ADE Test: the pot over a dark square with a TEST band, as the old test icon, so the two never look alike."""
    canvas = Image.new("RGBA", (512, 512), (28, 21, 18, 255))
    art = I32.resize((320, 320), Image.NEAREST)
    canvas.paste(art, (96, 50), art)
    draw = ImageDraw.Draw(canvas)
    draw.rectangle([0, 380, 512, 512], fill=(223, 74, 43, 255))
    font = ImageFont.truetype("arialbd.ttf", 96)  # Arial Bold, as the old test icon; Windows finds it by name
    box = draw.textbbox((0, 0), "TEST", font=font)
    draw.text(((512 - (box[2] - box[0])) // 2 - box[0], 446 - (box[3] - box[1]) // 2 - box[1]), "TEST", font=font, fill=(18, 13, 11, 255))
    out = Path("test")
    canvas.save(out / "icon.png")
    canvas.save(out / "app-icon-test.png")
    for name, size in [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)]:
        canvas.resize((size, size), Image.LANCZOS).save(out / name)
    sizes = [16, 24, 32, 48, 64, 256]
    canvas.resize((256, 256), Image.LANCZOS).save(out / "icon.ico", sizes=[(s, s) for s in sizes])
    canvas.save(out / "icon.icns")


release()
test()
print("ok")
