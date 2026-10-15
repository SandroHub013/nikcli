/**
 * The Ragu Code pot as data: one letter per pixel, `.` empty, the `icon16` grid of the logo generator
 * (ade-team/design/ragu-code/gen/logo.mjs), the drawing made for small sizes. Drawn by `Mark` and `Splash` in
 * `logo.tsx`, by ADE's `ragu-pot-mark.tsx`, and by `assets/make-ragu.py` into the favicons and the brand logo.
 */
export const PALETTE: Record<string, string> = {
  a: "#120d0b",
  b: "#24501a",
  c: "#4f8a2e",
  d: "#5a1712",
  e: "#a3271b",
  f: "#df4a2b",
  g: "#e8dfcf",
  h: "#f39a6b",
  i: "#f4e7cd",
}
export const POT_16 = [
  ".........g......",
  "......g...g.....",
  ".......g.g......",
  "......g..aa.....",
  ".....aaaacba....",
  "..aaafhffcfaaa..",
  ".aiiiiiiiiiiiia.",
  ".adddddddddddda.",
  "addffffffffffdda",
  ".aafhffffffffaa.",
  "..aeheeeeeeeea..",
  "..aefeeeeeeeea..",
  "..adddddddddda..",
  "...adddddddda...",
  "....aaaaaaaa....",
  "................",
]

/** Runs of one colour on a row, as [x, y, width, colour], so a row is a few rects and not sixteen. */
export function potRuns(grid: readonly string[] = POT_16): [number, number, number, string][] {
  const runs: [number, number, number, string][] = []
  grid.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const key = row[x]!
      let end = x + 1
      while (end < row.length && row[end] === key) end++
      if (key !== ".") runs.push([x, y, end - x, PALETTE[key]!])
      x = end
    }
  })
  return runs
}
