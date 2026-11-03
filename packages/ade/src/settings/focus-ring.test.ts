import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

/*
 * prova 4, item 15: the first Tab in Settings lands on «Generale», the selected
 * category, and showed no ring. `[data-active="true"]` sets a box-shadow of its
 * own (the lift), and it comes after the `:focus-visible` rule with the same
 * specificity, so it wins and the ring never paints. The selected one has its
 * own focus rule that keeps both.
 */
const css = readFileSync(new URL("./shell.css", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "")

const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selector: match[1]!.trim(),
  body: match[2]!,
}))

describe("the selected category in Settings shows its focus ring", () => {
  test("a rule for the selected category under :focus-visible paints the ring, and keeps the lift", () => {
    const rule = rules.find(
      ({ selector }) => selector.includes('[data-slot="category-button"][data-active="true"]:focus-visible'),
    )
    expect(rule, "no :focus-visible rule for the selected category").toBeDefined()
    expect(rule!.body).toContain("var(--ade-focus-ring)")
    expect(rule!.body).toContain("var(--ade-shadow-sm)")
  })

  test("the plain category still gets the ring from its own rule", () => {
    const rule = rules.find(({ selector }) => selector === '[data-slot="category-button"]:focus-visible')
    expect(rule?.body).toContain("var(--ade-focus-ring)")
  })
})
