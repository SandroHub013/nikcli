import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * Review of the UI, N22 and N24. The agents dialog printed «@general general» (the name in the gutter and in the
 * title); the slash menu padded its command column to the longest command, and cut the descriptions with no «…».
 */
const src = (file: string) => readFileSync(join(import.meta.dir, "../../../tui/src", file), "utf8").replace(/\r\n/g, "\n")

describe("the agents dialog", () => {
  test("the gutter is a colour dot: the name is the title, said once", () => {
    const dialog = src("component/dialog-agent.tsx")
    expect(dialog).toContain("●</text>")
    expect(dialog).not.toMatch(/gutter:[^\n]*@\{item\.name/)
  })
})

describe("the slash menu's columns", () => {
  const menu = src("component/prompt/autocomplete.tsx")

  test("the command column is capped", () => {
    expect(menu).toContain("export const COMMAND_COLUMN_MAX = 24")
    expect(menu).toContain("Math.min(longest, COMMAND_COLUMN_MAX)")
    expect(menu).toContain("display: item.display.padEnd(max + 2)")
  })

  test("a description that does not fit ends with «…» instead of being cut", () => {
    const at = menu.indexOf("\n                  {option().description}\n")
    const tag = menu.slice(menu.lastIndexOf("<text", at), at)
    expect(tag).toContain("truncate")
    expect(tag).toContain("minWidth={0}")
  })
})
