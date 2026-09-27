import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * Review area 2, MEDIO: sessions got a counter in their ids (`paneSequence`),
 * but browser, video, design, diff and file panes were still `prefix +
 * Date.now()`. Two `@ade browser open` in the same millisecond made two panes
 * with one id, and closing one closed both.
 */
test("lint: no pane id is the clock alone", () => {
  const source = readFileSync(join(import.meta.dir, "workbench.tsx"), "utf8")
  expect(source.match(/`[a-z]+\$\{Date\.now\(\)\}`/g) ?? []).toEqual([])
  expect(source).toContain("const newPaneId = (prefix: string) => `${prefix}${Date.now()}-${++paneSequence}`")
})
