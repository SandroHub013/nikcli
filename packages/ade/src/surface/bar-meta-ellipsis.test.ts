import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postcss from "postcss"

/*
 * DS2-11: between 1100 and about 1200px the bar's line of facts is cut by `overflow: hidden` with nothing to say so,
 * and it read «ADE 0.0.0 · senza isolamento · 2 s» (the last word of «2 sessioni» gone). The line was a flex row, and
 * `text-overflow` does nothing for the children of a flex container. It is now a line of inline items, so the whole
 * item that does not fit is replaced by an ellipsis, never cut mid-word. Read from the sheet: happy-dom does not lay
 * out. The live proof is the tester's.
 */
const sheet = postcss.parse(readFileSync(join(import.meta.dir, "..", "dev.css"), "utf8"))

const declsOf = (selector: string) => {
  const found = new Map<string, string>()
  sheet.walkRules((rule) => {
    if (rule.selector.trim() !== selector || rule.parent?.type !== "root") return
    rule.walkDecls((decl) => {
      found.set(decl.prop, decl.value)
    })
  })
  return found
}

describe("the bar's facts end in an ellipsis, not mid-word (DS2-11)", () => {
  const meta = declsOf('[data-slot="ade-project-meta"]')

  test("the line clips on one line and says so", () => {
    expect(meta.get("overflow")).toBe("hidden")
    expect(meta.get("white-space")).toBe("nowrap")
    expect(meta.get("text-overflow")).toBe("ellipsis")
  })

  test("and it is not a flex row, where text-overflow has nothing to act on", () => {
    expect(meta.get("display")).not.toBe("flex")
    expect(meta.get("display")).not.toBe("inline-flex")
  })

  test("its items stay atomic and apart: an inline-flex item with a margin, not a flex gap", () => {
    const item = declsOf('[data-slot="ade-meta-item"]')
    expect(item.get("display")).toBe("inline-flex")
    expect(item.get("vertical-align")).toBe("middle")
    expect(meta.has("gap")).toBe(false)
  })
})
