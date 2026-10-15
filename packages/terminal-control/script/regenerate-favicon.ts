#!/usr/bin/env bun
/**
 * Regenerate the opaque home-screen icons from favicon-v3.svg, the Ragu Code pot on its 16 px grid
 * (written by packages/ui/src/assets/make-ragu.py).
 *
 * Output, in packages/ui/src/assets/favicon/:
 *   - apple-touch-icon.png and apple-touch-icon-v3.png (180)
 *   - web-app-manifest-192x192.png and web-app-manifest-512x512.png, the maskable icons of site.webmanifest
 *
 * Each is the pot on ink, a whole number of pixels per grid pixel and centred on whole pixels, so it stays pixel
 * art: the script refuses a picture with any colour that is not the ink or one of the SVG's. A maskable icon keeps
 * every pixel of the pot inside the safe zone, the circle of 40 % of the size around the centre.
 *
 * Run from packages/terminal-control (from the root, `bun --cwd packages/terminal-control run …` prints bun's usage and runs nothing):
 *   bun script/regenerate-favicon.ts
 *
 * (terminal-control has @resvg/resvg-js as an optional dep with the
 * platform-specific native binary properly resolved.)
 */
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Resvg } from "@resvg/resvg-js"

const FAVICON_DIR = fileURLToPath(new URL("../../ui/src/assets/favicon/", import.meta.url))
const SVG_PATH = `${FAVICON_DIR}favicon-v3.svg`
const INK = "#120d0b"
const GRID = 16
const TARGETS = [
  { files: ["apple-touch-icon.png", "apple-touch-icon-v3.png"], size: 180, maskable: false },
  { files: ["web-app-manifest-192x192.png"], size: 192, maskable: true },
  { files: ["web-app-manifest-512x512.png"], size: 512, maskable: true },
] as const

const svg = await readFile(SVG_PATH, "utf8")
const body = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "")
const rects = [...body.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="(#[0-9a-f]{6})"\/>/g)].map(
  (m) => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]), fill: m[5]! }),
)
if (rects.length === 0) throw new Error(`no <rect> in ${SVG_PATH}`)

// How far the pot reaches from the centre of its grid, in grid pixels: the farthest corner of any rect.
const reach = Math.max(
  ...rects.flatMap((r) =>
    [r.x, r.x + r.w].flatMap((x) => [r.y, r.y + r.h].map((y) => Math.hypot(x - GRID / 2, y - GRID / 2))),
  ),
)
const allowed = new Set([INK, ...rects.map((r) => r.fill)])
const hex = (n: number) => n.toString(16).padStart(2, "0")

for (const { files, size, maskable } of TARGETS) {
  // A plain icon leaves a tenth of the size around the pot; a maskable one keeps it inside the safe zone.
  const k = maskable ? Math.floor((0.4 * size) / reach) : Math.floor((0.9 * size) / GRID)
  const offset = (size - GRID * k) / 2
  if (!Number.isInteger(offset)) throw new Error(`${size}: the pot at ${k}x does not centre on whole pixels`)
  const wrapped =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="${INK}"/>` +
    `<g transform="translate(${offset} ${offset}) scale(${k})" shape-rendering="crispEdges">${body}</g></svg>`
  const rendered = new Resvg(wrapped, { fitTo: { mode: "original" }, shapeRendering: 1 }).render()

  if (rendered.width !== size || rendered.height !== size) {
    throw new Error(`Unexpected render size: got ${rendered.width}x${rendered.height}, expected ${size}x${size}`)
  }
  const pixels = rendered.pixels
  for (let i = 0; i < pixels.length; i += 4) {
    const colour = `#${hex(pixels[i]!)}${hex(pixels[i + 1]!)}${hex(pixels[i + 2]!)}`
    if (pixels[i + 3] !== 255 || !allowed.has(colour))
      throw new Error(`${size}: pixel ${i / 4} is ${colour}/${pixels[i + 3]}, not a colour of the pot: it was resampled`)
  }

  const png = rendered.asPng()
  for (const file of files) {
    await writeFile(`${FAVICON_DIR}${file}`, png)
    console.log(`✓ ${file}  (${size}x${size}, pot at ${k}x, ${png.length} bytes)`)
  }
}
