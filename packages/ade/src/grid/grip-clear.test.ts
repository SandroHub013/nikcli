import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postcss from "postcss"

/*
 * DS2-3: the corner grip (index.css, `tile-resize`) is drawn 2px in from the cell's corner and is 14px wide. The dock's
 * last button sat 6px from the right and 4px from the bottom, so the arc crossed «Riprova» or «Consegna ora», and a
 * press on that corner resized the pane instead of pressing the button. Read from the sources: happy-dom does not lay
 * out. The live proof is the tester's.
 */
const read = (file: string) => postcss.parse(readFileSync(join(import.meta.dir, "..", file), "utf8"))

const px = (value: string | undefined) => {
  const match = /^(\d+(?:\.\d+)?)px$/.exec((value ?? "").trim())
  return match ? Number(match[1]) : Number.NaN
}

/** The value a rule in a sheet gives a property, the last one wins; `within` limits it to one at-rule. */
const valueOf = (root: postcss.Root, selector: string, prop: string, within?: string) => {
  let value: string | undefined
  root.walkRules((rule) => {
    if (rule.selector.trim() !== selector) return
    const parent = rule.parent
    const inAtRule = parent && parent.type === "atrule" && (parent as postcss.AtRule).params.startsWith("(max-height")
    if (within ? !inAtRule : inAtRule) return
    rule.walkDecls(prop, (decl) => {
      value = decl.value
    })
  })
  return value
}

const grip = read("index.css")
const pane = read("grid/pane.css")
const reach = px(valueOf(grip, '[data-slot="tile-resize"]', "right")) + px(valueOf(grip, '[data-slot="tile-resize"]', "width"))

describe("the resize grip does not sit on the dock's last button (DS2-3)", () => {
  test("the grip reaches 16px in from the cell's right edge", () => {
    expect(reach).toBe(16)
  })

  test("the answer strip keeps its last button clear of the grip", () => {
    const right = px(valueOf(pane, '[data-slot="pane-answers"]', "padding-right"))
    expect(right).toBeGreaterThan(reach)
  })

  test("so does «Consegna ora» when it floats over a short pane's terminal: once, not twice", () => {
    // The floating dock holds the answer strip, which already keeps 20px: the dock adds its own 6px, not another 20.
    const right = px(
      valueOf(pane, '[data-slot="pane-terminal"] ~ [data-slot="pane-dock"][data-offer]', "right", "short"),
    )
    const inner = px(valueOf(pane, '[data-slot="pane-answers"]', "padding-right"))
    expect(right).toBe(6)
    expect(right + inner).toBeGreaterThan(reach)
  })
})
