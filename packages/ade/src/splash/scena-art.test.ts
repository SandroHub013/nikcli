import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

describe("splash reference image preparation (Passo 1)", () => {
  const artDir = join(import.meta.dir, "art")
  const scenaPngPath = join(artDir, "scena.png")
  const scriptPath = join(import.meta.dir, "../../scripts/prepare-scena.py")

  test("prepare-scena.py script exists and is located in packages/ade/scripts/", () => {
    expect(existsSync(scriptPath)).toBe(true)
  })

  test("scena.png exists in packages/ade/src/splash/art/", () => {
    expect(existsSync(scenaPngPath)).toBe(true)
  })

  test("scena.png has compact file size under 450 KB (420.8 KB, reduced by > 70% from 1.48 MB)", () => {
    const stat = statSync(scenaPngPath)
    expect(stat.size).toBeLessThan(450 * 1024)
    expect(stat.size).toBeGreaterThan(300 * 1024)
  })

  test("scena.png has valid PNG signature and 1672x941 dimensions", () => {
    const buf = readFileSync(scenaPngPath)
    // PNG signature: 137 80 78 71 13 10 26 10
    expect(buf[0]).toBe(0x89)
    expect(buf[1]).toBe(0x50) // P
    expect(buf[2]).toBe(0x4e) // N
    expect(buf[3]).toBe(0x47) // G

    // IHDR starts at byte 12: chunk data at 16 (width: 4 bytes, height: 4 bytes)
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    expect(width).toBe(1672)
    expect(height).toBe(941)

    // Bit depth (byte 24) and Color type (byte 25): 3 = indexed-color (palette)
    const colorType = buf[25]
    expect(colorType).toBe(3)
  })

  test("palette contains at most 256 colors", () => {
    const buf = readFileSync(scenaPngPath)
    // Find PLTE chunk
    let offset = 8
    let plteLength = 0
    while (offset < buf.length) {
      const len = buf.readUInt32BE(offset)
      const type = buf.toString("ascii", offset + 4, offset + 8)
      if (type === "PLTE") {
        plteLength = len
        break
      }
      offset += 12 + len
    }
    expect(plteLength).toBeGreaterThan(0)
    expect(plteLength % 3).toBe(0)
    const colorCount = plteLength / 3
    expect(colorCount).toBeLessThanOrEqual(256)
  })
})
