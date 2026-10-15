import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * The orb's pupil is the product's mark. It was nikcli's N — three strokes
 * drawn by hand in `orb-mark.tsx` — and stayed after the rename, so the
 * toolbar of every ADE showed an «N» beside the grid button. Ragu Code's mark
 * is the pixel pot, the same one the microphone (`ragu-mic.tsx`) draws.
 *
 * `bun test` cannot load Solid `.tsx`, so the drawing is checked as source and
 * the geometry through the plain module both marks share.
 */

const here = import.meta.dir
const orb = readFileSync(join(here, "orb-mark.tsx"), "utf8")
const css = readFileSync(join(here, "orb-mark.css"), "utf8")
const mic = readFileSync(join(here, "ragu-mic.tsx"), "utf8")

describe("the orb's pupil is the ragù pot, not nikcli's N", () => {
  test("no N strokes and no N slot left in the drawing or its sheet", () => {
    expect(orb.includes('data-slot="orb-mark-n"')).toBe(false)
    expect(css.includes('"orb-mark-n"')).toBe(false)
    // The N's three strokes: two verticals and the diagonal between them.
    expect(/M3\.4 9V3|M3\.4 3L8\.6 9|M8\.6 3V9/.test(orb)).toBe(false)
  })

  test("the pupil draws the pot runs, and the sheet styles the pot slot", () => {
    expect(orb).toContain('data-slot="orb-mark-pot"')
    expect(orb).toContain('from "./pot-runs"')
    expect(orb).toContain("POT_RUNS.map")
    expect(css).toContain('[data-slot="orb-mark-pot"]')
  })

  test("the microphone and the orb share one pot, not two copies", () => {
    expect(mic).toContain('from "./pot-runs"')
    expect(/const POT_RUNS\b/.test(mic)).toBe(false)
  })

  test("the pot fits the box the orb draws it in", async () => {
    const { POT_RUNS, POT_BOX } = await import("./pot-runs")
    expect(POT_RUNS.length).toBeGreaterThan(10)
    for (const [x, y, w] of POT_RUNS) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(x + w).toBeLessThanOrEqual(POT_BOX.width)
      expect(y + 1).toBeLessThanOrEqual(POT_BOX.height)
    }
    expect(orb).toContain("POT_BOX")
  })
})
