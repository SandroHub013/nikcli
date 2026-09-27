import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postcss from "postcss"

/*
 * Two rings round the sidebar's search (contorni-terzo, 4): the box drew one
 * at 1px on `:focus-within`, and the field inside it took the global
 * `:focus-visible` ring as well, 2px, because its own `:focus` rule turned the
 * outline off and left the shadow. One ring stays, the box's.
 *
 * Read on the parsed sheets: the global rule sets `box-shadow`, so the field has
 * to set it back to `none` in a rule that outranks `:focus-visible`.
 */

const src = join(import.meta.dir, "..")
const rules = (file: string) => {
  const found: { selector: string; decls: Map<string, string> }[] = []
  postcss.parse(readFileSync(join(src, file), "utf-8")).walkRules((rule) => {
    const decls = new Map<string, string>()
    rule.walkDecls((decl) => {
      decls.set(decl.prop, decl.value.trim())
    })
    for (const selector of rule.selectors) found.push({ selector, decls })
  })
  return found
}

test("lint: the search draws one focus ring, the box's, and the field none of its own", () => {
  const sidebar = rules("sidebar/sidebar.css")
  const box = sidebar.filter((r) => r.selector === '[data-slot="search-field"]:focus-within')
  expect(box.length).toBe(1)
  expect(box[0]!.decls.get("box-shadow")).toBe("0 0 0 1px var(--ade-text)")

  // The global ring really is there to be undone.
  const global = rules("index.css").filter((r) => r.selector === ":focus-visible")
  expect(global.some((r) => r.decls.get("box-shadow") === "var(--ade-focus-ring)")).toBe(true)

  // The field, at the focus: the last rule for it decides, and it has to clear
  // both the outline and the shadow.
  const field = sidebar.filter((r) => /^\[data-slot="search-input"\]:focus(-visible)?$/.test(r.selector))
  expect(field.length > 0).toBe(true)
  const last = field.at(-1)!
  expect([last.selector, last.decls.get("outline"), last.decls.get("box-shadow")]).toEqual([
    last.selector,
    "none",
    "none",
  ])
})
