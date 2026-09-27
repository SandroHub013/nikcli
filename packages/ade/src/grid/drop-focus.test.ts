import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postcss from "postcss"

/*
 * A file dragged over the pane that has the focus showed nothing (contorni-terzo,
 * 2). The drop mark is an outline, and the focused pane's rule — more specific —
 * sets the outline too (to `none`, for a session, through `--ade-pane-focus`), so
 * the focus beat the drop. The drop has to win: it is the thing happening now.
 *
 * The cascade is worked out here on the real sheets: every rule that sets
 * `outline` and matches a focused session pane being dropped on, ranked by
 * specificity. The winner has to be strictly ahead, so the answer does not hang
 * on which sheet happens to load last.
 */

const src = join(import.meta.dir, "..")
const SHEETS = ["index.css", "grid/pane.css", "shots/tray.css"]

/** Specificity of one compound selector list entry: [ids, classes/attributes/pseudo-classes, types]. */
function specificity(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length
  const attrs = (selector.match(/\[[^\]]*\]/g) ?? []).length
  const classes = (selector.replace(/\[[^\]]*\]/g, "").match(/\.[\w-]+/g) ?? []).length
  const pseudos = (selector.replace(/\[[^\]]*\]/g, "").match(/:(?!:)[\w-]+/g) ?? []).length
  return ids * 10000 + (attrs + classes + pseudos) * 100
}

test("a file dropped on the focused pane shows the drop, not the focus", () => {
  const cell = document.createElement("div")
  cell.setAttribute("data-slot", "grid-cell")
  const pane = document.createElement("div")
  pane.setAttribute("data-component", "session-pane")
  pane.setAttribute("data-focused", "")
  pane.setAttribute("data-dropping", "true")
  cell.append(pane)
  document.body.append(cell)

  const candidates: { selector: string; value: string; weight: number }[] = []
  for (const file of SHEETS) {
    postcss.parse(readFileSync(join(src, file), "utf-8")).walkRules((rule) => {
      if (rule.parent?.type === "atrule") return
      const outline = rule.nodes.find((node) => node.type === "decl" && node.prop === "outline")
      if (!outline || outline.type !== "decl") return
      for (const selector of rule.selectors) {
        let matches = false
        try {
          matches = pane.matches(selector)
        } catch {
          matches = false
        }
        if (matches) candidates.push({ selector, value: outline.value, weight: specificity(selector) })
      }
    })
  }
  cell.remove()

  // Both sides have to be there, or the ranking below says nothing.
  expect(candidates.some((c) => c.selector.includes("data-dropping"))).toBe(true)
  expect(candidates.some((c) => c.selector.includes("data-focused"))).toBe(true)
  const ranked = [...candidates].sort((a, b) => b.weight - a.weight)
  const [first, second] = ranked
  expect([first!.selector, first!.selector.includes("data-dropping")]).toEqual([first!.selector, true])
  expect([first!.selector, second!.selector, first!.weight > second!.weight]).toEqual([
    first!.selector,
    second!.selector,
    true,
  ])
  expect(first!.value).toContain("var(--ade-text-weak)")
})
