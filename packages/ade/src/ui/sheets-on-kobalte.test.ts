import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * kobalte-overlay: the sheets moved onto `Sheet` (`sheet.ts`), one per
 * commit. What a Sheet does is tested rendered in `sheet.test.ts`; this lint
 * keeps each moved sheet on it, named by its title, and off the hand-made
 * Overlay that trapped nothing.
 */
const SHEETS = [["decisions/decisions-sheet.tsx", "decisions-sheet"]] as const

describe("lint: the sheets are Kobalte dialogs", () => {
  test("lint: each moved sheet renders a Sheet named by a SheetTitle, and no Overlay or Surface of its own", () => {
    expect(SHEETS.length).toBeGreaterThan(0)
    for (const [file, component] of SHEETS) {
      const view = readFileSync(join(import.meta.dir, "..", file), "utf8")
      expect([file, view.includes(`<Sheet component="${component}"`)]).toEqual([file, true])
      expect([file, view.includes("<SheetTitle")]).toEqual([file, true])
      expect([file, view.includes("<Overlay") || view.includes("<Surface")]).toEqual([file, false])
    }
  })
})
