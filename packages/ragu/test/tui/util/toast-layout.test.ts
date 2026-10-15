import { describe, expect, test } from "bun:test"
import { toastGlyph, toastHeight, toastTextWidth, toastTops } from "@tui/util/toast-layout"

/* Review of the UI, N26: five rows for a one-line message, and «[i]» «[+]» «[x]» for glyphs. */
describe("toast layout", () => {
  test("a one-line message is a three-row toast, a titled one four", () => {
    expect(toastHeight("Session pinned", undefined, 50)).toBe(3)
    expect(toastHeight("Saved", "Config", 50)).toBe(4)
  })

  test("a message that wraps takes the rows it wraps to", () => {
    expect(toastHeight("x".repeat(120), undefined, 50)).toBe(2 + 3)
    expect(toastHeight("one\ntwo", undefined, 50)).toBe(2 + 2)
  })

  test("the toasts stack with one row between them", () => {
    expect(toastTops([3, 4, 3], 2, 1)).toEqual([2, 6, 11])
  })

  test("the text width follows the terminal, capped at the panel's 60", () => {
    expect(toastTextWidth(200)).toBe(50)
    expect(toastTextWidth(40)).toBe(24)
  })

  test("glyphs are single marks, none of them ASCII brackets", () => {
    for (const variant of ["info", "success", "warning", "error"] as const) {
      const glyph = toastGlyph(variant)
      expect(glyph.length).toBe(1)
      expect(glyph).not.toMatch(/[\[\]]/)
    }
    expect(new Set(["info", "success", "warning", "error"].map((v) => toastGlyph(v as never))).size).toBe(4)
  })
})
