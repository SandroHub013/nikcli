import { describe, expect, test } from "bun:test"
import path from "path"
import { createStandaloneTheme } from "@tui/context/theme"
import { loadBuiltInTheme } from "@tui/context/theme-catalog"
import { chipText, voiceChip } from "@tui/component/prompt/chip"
import { contrastRatio } from "@tui/context/contrast"

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
    const source = await Bun.file(path.join(import.meta.dir, "../../../tui/src/component/prompt/index.tsx")).text()
    const offenders = source.split("\n").filter((line) => /fg[=:]\s*\{?\s*theme\.surface\.base/.test(line))
    expect(offenders).toEqual([])
  })
})

/*
 * P0 #8 of the triple-A review: the rec chip was red all the time, with the word «rec» in muted on the red, 1.2:1 in
 * light mode and 1.3:1 in dark, on every screen with a prompt.
 */
describe("the rec chip", () => {
  for (const mode of ["dark", "light"] as const) {
    const theme = createStandaloneTheme({ document, mode }).theme

    test(`at rest it is quiet and readable (${mode})`, () => {
      const chip = voiceChip(theme, "idle")
      expect(chip.bg).toEqual(theme.surface.offset)
      expect(contrastRatio(chip.fg, chip.bg)).toBeGreaterThanOrEqual(4.5)
    })

    test(`red only while it records or transcribes, with text that reads on the red (${mode})`, () => {
      for (const status of ["recording", "transcribing"] as const) {
        const chip = voiceChip(theme, status)
        expect(chip.bg).toEqual(theme.status.error.fg)
        expect(contrastRatio(chip.fg, chip.bg)).toBeGreaterThanOrEqual(4.5)
      }
    })
  }

  test("the prompt draws the chip from voiceChip, with no muted word on it", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../../../tui/src/component/prompt/index.tsx")).text()
    expect(source).toContain("voiceChip(theme, voiceStatus())")
    expect(source).not.toMatch(/fg: theme\.foreground\.muted \}\}>rec</)
  })
})
