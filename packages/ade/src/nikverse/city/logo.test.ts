import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SVGLoader } from "three/addons/loaders/SVGLoader.js"
import { LOGO_SCALE, LOGO_SVG, logoVoxels, parseLogo, voxelRect, type LogoRect } from "./logo"

const BRAND = join(import.meta.dir, "..", "..", "..", "..", "console", "app", "src", "asset", "brand")
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const order = (a: LogoRect, b: LogoRect) => a.color.localeCompare(b.color) || a.y - b.y || a.x - b.x

/** The squares as three.js's own SVG loader reads them: a second reading, made a different way. */
function viaLoader(svg: string): LogoRect[] {
  const rects: LogoRect[] = []
  for (const path of new SVGLoader().parse(svg).paths) {
    const color = String((path.userData as { style: { fill: string } }).style.fill).toUpperCase()
    for (const sub of path.subPaths) {
      const points = sub.getPoints()
      const xs = points.map((p) => p.x)
      const ys = points.map((p) => p.y)
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      rects.push({ x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, color })
    }
  }
  return rects
}

describe("the logo is the brand's own file", () => {
  test("the copy in the package has the same hash as the brand's logo, byte for byte", () => {
    const brand = readFileSync(join(BRAND, "nikcli-logo-dark.svg"))
    const copy = readFileSync(join(import.meta.dir, "nikcli-logo-dark.svg"))
    expect(hash(copy)).toBe(hash(brand))
    expect(hash(LOGO_SVG)).toBe(hash(brand))
  })

  test("it is 17 squares of 60 on a 60 grid, in the two colours of the file, on a 240 by 300 box", () => {
    const logo = parseLogo()
    expect([logo.width, logo.height]).toEqual([240, 300])
    expect(logo.rects).toHaveLength(17)
    expect(logo.rects.filter((r) => r.color === "#4B4646")).toHaveLength(6)
    expect(logo.rects.filter((r) => r.color === "#F1ECEC")).toHaveLength(11)
    for (const r of logo.rects) expect([r.w, r.h, r.x % 60, r.y % 60]).toEqual([60, 60, 0, 0])
  })

  test("the squares are the ones the SVG loader reads from the same file, with tolerance 0", () => {
    const mine = [...parseLogo().rects].sort(order)
    const theirs = viaLoader(LOGO_SVG).sort(order)
    expect(theirs).toHaveLength(17)
    expect(mine).toEqual(theirs)
  })

  test("the light logo, which the daytime will use, reads the same way", () => {
    const light = readFileSync(join(BRAND, "nikcli-logo-light.svg"), "utf8")
    expect([...parseLogo(light).rects].sort(order)).toEqual(viaLoader(light).sort(order))
  })

  test("a path that is not made of squares is refused, not approximated", () => {
    const wrap = (d: string) => `<svg viewBox="0 0 10 10"><path d="${d}" fill="#000000"/></svg>`
    for (const d of ["M0 0L10 5L0 10Z", "M0 0H10V10H0", "M0 0H10V10Z", "M0 0H10L5 5H0Z", "M0 0H10V0H0Z", "M0 0H10V10H0V5Z", "M0 0C1 1 2 2 3 3Z"])
      expect(() => parseLogo(wrap(d))).toThrow()
    expect(() => parseLogo('<svg viewBox="0 0 10 10"></svg>')).toThrow()
    expect(() => parseLogo('<svg><path d="M0 0H1V1H0Z" fill="#000000"/></svg>')).toThrow()
    expect(() => parseLogo('<svg viewBox="0 0 10 10"><path d="M0 0H1V1H0Z" fill="url(#g)"/></svg>')).toThrow()
  })

  test("relative and repeated commands read to the same squares as the absolute ones", () => {
    const abs = parseLogo('<svg viewBox="0 0 10 10"><path d="M2 2H6V6H2ZM6 2H8V4H6Z" fill="#aabbcc"/></svg>')
    const rel = parseLogo('<svg viewBox="0 0 10 10"><path d="m2 2h4v4h-4zm4 0h2v2h-2z" fill="#aabbcc"/></svg>')
    expect(rel.rects).toEqual(abs.rects)
    expect(abs.rects).toEqual([
      { x: 2, y: 2, w: 4, h: 4, color: "#AABBCC" },
      { x: 6, y: 2, w: 2, h: 2, color: "#AABBCC" },
    ])
  })
})

describe("the voxels of the hologram", () => {
  test("each square becomes one voxel, and reads back to the same square with tolerance 0", () => {
    const logo = parseLogo()
    const voxels = logoVoxels(logo)
    expect(voxels).toHaveLength(logo.rects.length)
    logo.rects.forEach((rect, i) => expect(voxelRect(logo, voxels[i], LOGO_SCALE)).toEqual(rect))
  })

  test("the scale is a power of two, which is what makes every position exact", () => {
    expect(Number.isInteger(Math.log2(LOGO_SCALE))).toBe(true)
  })

  test("the logo is centred on its own centre, y up: the top-left square is up and to the left", () => {
    const [first] = logoVoxels(parseLogo(), LOGO_SCALE).filter((v) => v.cx < 0 && v.cy > 0)
    expect(first).toBeDefined()
    const all = logoVoxels(parseLogo())
    expect(Math.min(...all.map((v) => v.cx - v.sx / 2))).toBe(-(240 * LOGO_SCALE) / 2)
    expect(Math.max(...all.map((v) => v.cy + v.sy / 2))).toBe((300 * LOGO_SCALE) / 2)
  })

  test("a redrawn logo is caught: moving one square by one unit fails the read-back", () => {
    const logo = parseLogo()
    const voxels = logoVoxels(logo)
    voxels[3] = { ...voxels[3], cx: voxels[3].cx + LOGO_SCALE }
    expect(voxelRect(logo, voxels[3], LOGO_SCALE)).not.toEqual(logo.rects[3])
  })
})
