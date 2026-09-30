import { describe, expect, test } from "bun:test"
import { PERMISSIONS } from "./api"
import { formatSize, permissionText } from "./words"

describe("the words of the host", () => {
  test("every permission has words that say what it lets the plugin do, and none is the key itself", () => {
    const texts = PERMISSIONS.map(permissionText)
    expect(new Set(texts).size).toBe(PERMISSIONS.length)
    for (const [index, text] of texts.entries()) {
      expect(text.length).toBeGreaterThan(10)
      expect(text).not.toContain(PERMISSIONS[index]!)
    }
  })

  test("sessions:read says it is the titles and the state and not the content", () => {
    expect(permissionText("sessions:read")).toMatch(/titoli|titles/)
    expect(permissionText("sessions:read")).toMatch(/non il loro contenuto|not their content/)
  })

  test("sizes read as a person would", () => {
    expect(formatSize(0)).toBe("0 B")
    expect(formatSize(999)).toBe("999 B")
    expect(formatSize(1500)).toBe("2 KB")
    expect(formatSize(3_400_000)).toBe("3.4 MB")
    expect(formatSize(12_600_000)).toBe("13 MB")
    expect(formatSize(-1)).toBe("—")
    expect(formatSize(NaN)).toBe("—")
  })
})
