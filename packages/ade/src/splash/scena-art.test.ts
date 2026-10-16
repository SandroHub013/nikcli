import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { inflateSync } from "node:zlib"

interface DecodedPng {
  width: number
  height: number
  colorType: number
  rgb: Uint8Array
}

/**
 * Lightweight pure-TS PNG decoder supporting RGB truecolor (colorType 2)
 * and indexed-color with palette (colorType 3).
 */
function decodePngRgb(buf: Buffer): DecodedPng {
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const colorType = buf[25]

  let offset = 8
  const idatParts: Buffer[] = []
  let palette: Buffer | null = null

  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset)
    const type = buf.toString("ascii", offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + len)
    if (type === "IDAT") idatParts.push(data)
    else if (type === "PLTE") palette = data
    offset += 12 + len
  }

  const raw = inflateSync(Buffer.concat(idatParts))
  const rgb = new Uint8Array(width * height * 3)

  if (colorType === 2) {
    const bpp = 3
    const stride = 1 + width * bpp
    const prevRow = new Uint8Array(width * bpp)
    const currRow = new Uint8Array(width * bpp)

    for (let y = 0; y < height; y++) {
      const filter = raw[y * stride]
      const rowRaw = raw.subarray(y * stride + 1, (y + 1) * stride)

      for (let i = 0; i < width * bpp; i++) {
        const x = rowRaw[i]
        const a = i >= bpp ? currRow[i - bpp] : 0
        const b = prevRow[i]
        const c = i >= bpp ? prevRow[i - bpp] : 0

        let val = 0
        if (filter === 0) val = x
        else if (filter === 1) val = (x + a) & 0xff
        else if (filter === 2) val = (x + b) & 0xff
        else if (filter === 3) val = (x + Math.floor((a + b) / 2)) & 0xff
        else if (filter === 4) {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          val = (x + pr) & 0xff
        }
        currRow[i] = val
      }
      rgb.set(currRow, y * width * 3)
      prevRow.set(currRow)
    }
  } else if (colorType === 3 && palette) {
    const bpp = 1
    const stride = 1 + width * bpp
    const prevRow = new Uint8Array(width)
    const currRow = new Uint8Array(width)

    for (let y = 0; y < height; y++) {
      const filter = raw[y * stride]
      const rowRaw = raw.subarray(y * stride + 1, (y + 1) * stride)

      for (let i = 0; i < width; i++) {
        const x = rowRaw[i]
        const a = i >= bpp ? currRow[i - bpp] : 0
        const b = prevRow[i]
        const c = i >= bpp ? prevRow[i - bpp] : 0

        let val = 0
        if (filter === 0) val = x
        else if (filter === 1) val = (x + a) & 0xff
        else if (filter === 2) val = (x + b) & 0xff
        else if (filter === 3) val = (x + Math.floor((a + b) / 2)) & 0xff
        else if (filter === 4) {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          val = (x + pr) & 0xff
        }
        currRow[i] = val
        const colorIdx = val * 3
        const outIdx = (y * width + i) * 3
        rgb[outIdx] = palette[colorIdx]
        rgb[outIdx + 1] = palette[colorIdx + 1]
        rgb[outIdx + 2] = palette[colorIdx + 2]
      }
      prevRow.set(currRow)
    }
  }

  return { width, height, colorType, rgb }
}

interface Zone {
  name: string
  x0: number
  x1: number
  y0: number
  y1: number
}

const CRITICAL_ZONES: Zone[] = [
  { name: "Bottiglia dell'olio", x0: 1254, x1: 1463, y0: 470, y1: 626 },
  { name: "Superficie del ragù", x0: 836, x1: 1254, y0: 313, y1: 469 },
  { name: "Riflessi di «Code»", x0: 836, x1: 1254, y0: 627, y1: 940 },
  { name: "Portatile e aglio", x0: 627, x1: 836, y0: 470, y1: 626 },
]

describe("splash reference image preparation and fidelity (P1-1)", () => {
  const artDir = join(import.meta.dir, "art")
  const scenaPngPath = join(artDir, "scena.png")
  const scriptPath = join(import.meta.dir, "../../scripts/prepare-scena.py")
  const refPath =
    process.env.RAGU_SPLASH_REF ??
    resolve(import.meta.dir, "../../../../../ade-team/design/ragu-splash/ref/scena-sinistra.png")

  test("prepare-scena.py script exists and is located in packages/ade/scripts/", () => {
    expect(existsSync(scriptPath)).toBe(true)
  })

  test("scena.png exists in packages/ade/src/splash/art/", () => {
    expect(existsSync(scenaPngPath)).toBe(true)
  })

  test("scena.png has valid PNG signature and 1672x941 dimensions", () => {
    const buf = readFileSync(scenaPngPath)
    expect(buf[0]).toBe(0x89)
    expect(buf[1]).toBe(0x50) // P
    expect(buf[2]).toBe(0x4e) // N
    expect(buf[3]).toBe(0x47) // G

    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    expect(width).toBe(1672)
    expect(height).toBe(941)
  })

  test("scena.png size is within production limit (< 1.4 MB)", () => {
    const stat = statSync(scenaPngPath)
    expect(stat.size).toBeLessThan(1400 * 1024)
  })

  test("scena.png preserves authentic colors across all 4 critical zones (P1-1)", () => {
    if (!existsSync(refPath)) {
      console.warn(`Reference image not found at ${refPath}, skipping fidelity test`)
      return
    }

    const refBuf = readFileSync(refPath)
    const testBuf = readFileSync(scenaPngPath)

    const refPng = decodePngRgb(refBuf)
    const testPng = decodePngRgb(testBuf)

    expect(testPng.width).toBe(refPng.width)
    expect(testPng.height).toBe(refPng.height)

    // Check each of the 4 critical zones identified in review P1-1
    for (const zone of CRITICAL_ZONES) {
      let maxZoneDiff = 0
      let errorPixelsCount = 0

      for (let y = zone.y0; y < zone.y1; y++) {
        for (let x = zone.x0; x < zone.x1; x++) {
          const idx = (y * refPng.width + x) * 3
          const dr = Math.abs(refPng.rgb[idx] - testPng.rgb[idx])
          const dg = Math.abs(refPng.rgb[idx + 1] - testPng.rgb[idx + 1])
          const db = Math.abs(refPng.rgb[idx + 2] - testPng.rgb[idx + 2])
          const maxChan = Math.max(dr, dg, db)
          if (maxChan > 24) {
            errorPixelsCount++
          }
          if (maxChan > maxZoneDiff) {
            maxZoneDiff = maxChan
          }
        }
      }

      // In the 256-color quantized image, every single one of these zones had errors > 24 (up to 81)
      expect(errorPixelsCount).toBe(0)
      expect(maxZoneDiff).toBeLessThanOrEqual(24)
    }
  })

  test("scena.png overall fidelity: >= 99.9% pixels within 24 levels and no pixel exceeds 40 levels", () => {
    if (!existsSync(refPath)) {
      return
    }

    const refBuf = readFileSync(refPath)
    const testBuf = readFileSync(scenaPngPath)

    const refPng = decodePngRgb(refBuf)
    const testPng = decodePngRgb(testBuf)

    const totalPixels = refPng.width * refPng.height
    let over24 = 0
    let maxDiff = 0

    for (let i = 0; i < totalPixels; i++) {
      const idx = i * 3
      const dr = Math.abs(refPng.rgb[idx] - testPng.rgb[idx])
      const dg = Math.abs(refPng.rgb[idx + 1] - testPng.rgb[idx + 1])
      const db = Math.abs(refPng.rgb[idx + 2] - testPng.rgb[idx + 2])
      const maxChan = Math.max(dr, dg, db)
      if (maxChan > 24) {
        over24++
      }
      if (maxChan > maxDiff) {
        maxDiff = maxChan
      }
    }

    const ratioUnder24 = (totalPixels - over24) / totalPixels
    expect(ratioUnder24).toBeGreaterThanOrEqual(0.999)
    expect(maxDiff).toBeLessThanOrEqual(40)
  })
})
