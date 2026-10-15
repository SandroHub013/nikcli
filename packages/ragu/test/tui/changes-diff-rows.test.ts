import { describe, expect, test } from "bun:test"
import { parseDiffRows } from "@tui/routes/changes/diff-rows"

/**
 * P0 #9 of the triple-A review: in Changes the highlighted line and its comment landed lower than the line chosen.
 * The row index was the line's index in the raw patch, which counts the file headers and every `@@`, while the diff
 * view numbers only the lines it draws: added, removed and context.
 */

const PATCH = [
  "Index: src/a.ts",
  "===================================================================",
  "--- src/a.ts",
  "+++ src/a.ts",
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  "@@ -10,2 +10,3 @@",
  " ten",
  "+ten and a half",
  " eleven",
  "\\ No newline at end of file",
].join("\n")

describe("the rows of a patch in Changes", () => {
  test("are numbered as the diff view draws them, headers and hunk lines not counted", () => {
    const rows = parseDiffRows(PATCH)
    expect(rows.map((row) => row.visualLine)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(rows.map((row) => row.text)).toEqual(["one", "two", "TWO", "three", "ten", "ten and a half", "eleven"])
  })

  test("keep the file's line numbers and anchors", () => {
    const rows = parseDiffRows(PATCH)
    expect(rows.map((row) => row.anchor)).toEqual(["new:1", "old:2", "new:2", "new:3", "new:10", "new:11", "new:12"])
  })
})
