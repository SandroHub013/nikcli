import { describe, expect, test } from "bun:test"
import { PALETTE, POT_16, potRuns } from "./ragu-pot"

describe("the Ragu Code pot in the bar", () => {
  test("is a 16 x 16 drawing whose every letter is a colour of the palette", () => {
    expect(POT_16).toHaveLength(16)
    for (const row of POT_16) {
      expect(row).toHaveLength(16)
      for (const key of row) if (key !== ".") expect(PALETTE[key]).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  test("its runs cover every painted pixel once, and nothing else", () => {
    const painted = new Set<string>()
    for (const [x, y, width, fill] of potRuns()) {
      for (let i = 0; i < width; i++) {
        const key = `${x + i},${y}`
        expect(painted.has(key)).toBe(false)
        painted.add(key)
        expect(PALETTE[POT_16[y]![x + i]!]).toBe(fill)
      }
    }
    const expected = POT_16.join("").replaceAll(".", "").length
    expect(painted.size).toBe(expected)
  })
})
