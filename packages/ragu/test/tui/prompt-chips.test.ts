import { describe, expect, test } from "bun:test"
import path from "path"
import { createStandaloneTheme } from "@tui/context/theme"
import { loadBuiltInTheme } from "@tui/context/theme-catalog"
import { chipText } from "@tui/component/prompt/chip"

/*
 * The rec and web chips under the prompt wrote their text in the page's
 * background colour. In ADE that background is transparent, so the chips were
 * coloured blocks with nothing in them (screenshot of 2026-10-13 19:48).
 */

const document = (await loadBuiltInTheme("ragu")) as { theme: Record<string, unknown> }
const transparent = createStandaloneTheme({
  document: { ...document, theme: { ...document.theme, background: "none" } },
  mode: "dark",
}).theme

describe("prompt chips", () => {
  test("on a transparent background the chip text is still an opaque colour", () => {
    expect(transparent.surface.base.a).toBe(0)
    for (const chip of [transparent.status.error.fg, transparent.accent.fg]) {
      expect(chipText(chip).a).toBe(1)
      // Readable against the chip itself, which is what it is drawn on.
      const delta = Math.abs(chipText(chip).r - chip.r) + Math.abs(chipText(chip).g - chip.g)
      expect(delta).toBeGreaterThan(0.5)
    }
  })

  test("no text in the prompt is drawn in the page background colour", async () => {
    const source = await Bun.file(
      path.join(import.meta.dir, "../../../tui/src/component/prompt/index.tsx"),
    ).text()
    const offenders = source.split("\n").filter((line) => /fg[=:]\s*\{?\s*theme\.surface\.base/.test(line))
    expect(offenders).toEqual([])
  })
})
