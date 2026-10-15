import { describe, expect, test } from "bun:test"
import { TIPS } from "@tui/feature-plugins/home/tips-view"
import { tuiSource } from "./tui-source"

/**
 * P0 #7 of the triple-A review: the home's tip sat in a box 4 rows high with 3 of them padding, so a tip that wraps
 * lost its second line. The box has to hold the longest tip at the widths the home is drawn at, down to a narrow pane.
 */

/** Lines `text` takes when wrapped at word boundaries in `width` columns. */
function lines(text: string, width: number): number {
  let count = 1
  let used = 0
  for (const word of text.split(" ")) {
    const need = used === 0 ? word.length : used + 1 + word.length
    if (need <= width) used = need
    else {
      count++
      used = word.length
    }
  }
  return count
}

describe("the home's tip", () => {
  test("has rows enough for the longest tip, at 80, 60 and 40 columns", async () => {
    const source = await tuiSource("feature-plugins/home/tips.tsx")
    const box = /<box([^>]*)>\s*<Show when=\{show\(\)\}>/.exec(source)?.[1] ?? ""
    const height = Number(/\bheight=\{(\d+)\}/.exec(box)?.[1])
    const padding = Number(/\bpaddingTop=\{(\d+)\}/.exec(box)?.[1] ?? 0)
    expect(height).toBeGreaterThan(0)
    const plain = TIPS.map((tip) => tip.replace(/\{\/?highlight\}/g, ""))
    // The box is at most 75 wide, and «● Tip » takes 6 of them.
    for (const columns of [80, 60, 40]) {
      const width = Math.min(75, columns) - 6
      const needed = Math.max(...plain.map((tip) => lines(tip, width)))
      expect({ columns, rows: height - padding }).toEqual({ columns, rows: Math.max(needed, height - padding) })
    }
  })
})
