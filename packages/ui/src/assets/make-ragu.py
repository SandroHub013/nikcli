"""
The Ragu Code pictures of the web app, the desktop shell and the RaguVerse: the favicons, the brand logo, the
wordmark and the social picture. All come from the grids of the logo generator
(ade-team/design/ragu-code/gen/logo.mjs, which writes out/grids.json): the pot (`icon16`, `icon32`) and the pot
with its name (`combo` for dark surfaces, `comboLight` for light ones). They are scaled by whole factors with no
interpolation, in the palette's own colours.

    python make-ragu.py [path to grids.json]

Run from this folder. Then, from packages/terminal-control, for the home-screen icons drawn from favicon-v3.svg:

    bun script/regenerate-favicon.ts

Needs Pillow. The line under the social picture is set in Consolas, which Windows finds by name.
"""
import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
GRIDS = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Favorites" / "ade-team" / "design" / "ragu-code" / "out" / "grids.json"
G = json.loads(GRIDS.read_text(encoding="utf-8"))
ICON16, ICON32, COMBO, COMBO_LIGHT = G["icon16"], G["icon32"], G["combo"], G["comboLight"]

INK = "#120d0b"
CREAM = "#f4e7cd"
# The phrase of the README's first lines, the one that says what Ragu Code is.
TAGLINE = "The open source coding agent, with ADE"


def check_pot() -> None:
    """The 16 px pot of the code (`ragu-pot.ts`) and of the generator must be the same drawing."""
    src = (HERE.parent / "components" / "ragu-pot.ts").read_text(encoding="utf-8")
    palette = dict(re.findall(r'^\s*([a-z]): "(#[0-9a-f]{6})",$', src, re.M))
    rows = re.findall(r'^\s*"([.a-z]{16})",$', src, re.M)
    pot = [[palette[key] if key != "." else None for key in row] for row in rows]
    if pot != ICON16:
        sys.exit("ragu-pot.ts and icon16 of grids.json are not the same drawing: regenerate one from the other")


def rgba(colour: str) -> tuple[int, int, int, int]:
    return (int(colour[1:3], 16), int(colour[3:5], 16), int(colour[5:7], 16), 255)


def crop(grid: list) -> list:
    """The grid without its empty rows and columns around."""
    rows = [y for y, row in enumerate(grid) if any(row)]
    cols = [x for x in range(len(grid[0])) if any(row[x] for row in grid)]
    return [row[cols[0] : cols[-1] + 1] for row in grid[rows[0] : rows[-1] + 1]]


def picture(grid: list, k: int = 1) -> Image.Image:
    """The grid as a picture, each of its pixels a k by k square."""
    im = Image.new("RGBA", (len(grid[0]), len(grid)), (0, 0, 0, 0))
    for y, row in enumerate(grid):
        for x, colour in enumerate(row):
            if colour:
                im.putpixel((x, y), rgba(colour))
    return im.resize((im.width * k, im.height * k), Image.NEAREST)


def centred(art: Image.Image, width: int, height: int, background: str | None = None) -> Image.Image:
    """`art` in the middle of a width by height picture; whole-pixel offsets, so nothing is resampled."""
    out = Image.new("RGBA", (width, height), rgba(background) if background else (0, 0, 0, 0))
    out.paste(art, ((width - art.width) // 2, (height - art.height) // 2), art)
    return out


def pot(size: int) -> Image.Image:
    """The pot on a transparent square, as ADE's icons: the 16 px drawing below 32, else the 32 px one."""
    grid = ICON16 if size < 32 else ICON32
    return centred(picture(grid, max(1, size // len(grid))), size, size)


def runs(grid: list) -> list[tuple[int, int, int, str]]:
    """Runs of one colour on a row, as (x, y, width, colour)."""
    out = []
    for y, row in enumerate(grid):
        x = 0
        while x < len(row):
            end = x + 1
            while end < len(row) and row[end] == row[x]:
                end += 1
            if row[x]:
                out.append((x, y, end - x, row[x]))
            x = end
    return out


def write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8", newline="\n")


def favicons() -> None:
    """The tab icons. The SVG is the 16 px drawing, the one made for the size a tab shows it at."""
    rects = "".join(f'  <rect x="{x}" y="{y}" width="{w}" height="1" fill="{c}"/>\n' for x, y, w, c in runs(ICON16))
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">\n{rects}</svg>\n'
    sizes = [16, 32, 48]
    for name in ["favicon", "favicon-v3"]:
        write(HERE / "favicon" / f"{name}.svg", svg)
        pot(48).save(HERE / "favicon" / f"{name}.ico", sizes=[(s, s) for s in sizes], append_images=[pot(s) for s in sizes])
    for name in ["favicon-96x96.png", "favicon-96x96-v3.png"]:
        pot(96).save(HERE / "favicon" / name)


def brand_logo() -> None:
    """
    The logo the RaguVerse builds its hologram from: one 15-unit square per pixel of the 16 px pot, a path per
    colour, which is what `raguverse/city/logo.ts` reads. The pot has no light variant, so the two files match.
    """
    cell = 15
    paths = []
    for colour in dict.fromkeys(c for row in ICON16 for c in row if c):
        d = "".join(
            f"M{x * cell} {y * cell}H{(x + 1) * cell}V{(y + 1) * cell}H{x * cell}Z"
            for y, row in enumerate(ICON16)
            for x, c in enumerate(row)
            if c == colour
        )
        paths.append(f'<path d="{d}" fill="{colour.upper()}"/>\n')
    side = 16 * cell
    svg = f'<svg width="{side}" height="{side}" viewBox="0 0 {side} {side}" fill="none" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">\n{"".join(paths)}</svg>\n'
    copy = HERE.parents[2] / "ade" / "src" / "raguverse" / "city" / "ragu-logo-dark.svg"
    for path in [HERE / "brand" / "ragu-logo-dark.svg", HERE / "brand" / "ragu-logo-light.svg", copy]:
        write(path, svg)
    for tone in ["dark", "light"]:
        picture(ICON16, 30).save(HERE / "brand" / f"ragu-logo-{tone}.png")


def name_words(grid: list) -> tuple[list, list]:
    """The two words of the combo, RAGU and CODE: right of the pot's last column, split where a row is empty."""
    painted = [any(row[x] for row in grid) for x in range(len(grid[0]))]
    pot_end = painted.index(False, painted.index(True))
    right = [row[pot_end:] for row in grid]
    bands, band = [], []
    for row in right:
        if any(row):
            band.append(row)
        elif band:
            bands.append(band)
            band = []
    if band:
        bands.append(band)
    ragu, code = (crop(b) for b in bands)
    return ragu, code


def wordmark() -> None:
    """
    RAGU CODE on one line, as the combo spells it: its two words side by side at the top, four grid pixels apart,
    on a transparent 632 by 206 picture. `dark` is the one for dark surfaces (`combo`), `light` for light ones.
    """
    for tone, grid in [("dark", COMBO), ("light", COMBO_LIGHT)]:
        ragu, code = name_words(grid)
        gap = 4
        width = len(ragu[0]) + gap + len(code[0])
        height = max(len(ragu), len(code))
        line = [[None] * width for _ in range(height)]
        for y, row in enumerate(ragu):
            line[y][: len(row)] = row
        for y, row in enumerate(code):
            line[y][len(ragu[0]) + gap :] = row
        k = min(632 // width, 206 // height)
        centred(picture(line, k), 632, 206).save(HERE / "images" / f"wordmark-{tone}.png")


def social() -> None:
    """The picture links show: the combo on ink at a whole factor, and the README's phrase under it in cream."""
    art = picture(crop(COMBO), 12)
    font = ImageFont.truetype("consola.ttf", 44)
    for name in ["social-share.png", "social-share-black.png"]:
        out = Image.new("RGBA", (1280, 721), rgba(INK))
        draw = ImageDraw.Draw(out)
        box = draw.textbbox((0, 0), TAGLINE, font=font)
        gap = 64
        top = (721 - (art.height + gap + box[3] - box[1])) // 2
        out.paste(art, ((1280 - art.width) // 2, top), art)
        draw.text(((1280 - (box[2] - box[0])) // 2 - box[0], top + art.height + gap - box[1]), TAGLINE, font=font, fill=rgba(CREAM))
        out.convert("RGB").save(HERE / "images" / name)


check_pot()
favicons()
brand_logo()
wordmark()
social()
print("ok")
