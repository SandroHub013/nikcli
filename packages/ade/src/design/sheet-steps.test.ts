import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postcss from "postcss"

/*
 * DS2-6: with one decision or one proposal, the head drew a single 18x4px dash in the accent beside the close cross, and
 * it read as a «minimise» control: pomodoro on something that is not a button. A stepper says «which of several», so it
 * is drawn from two items on, and the current step is ink, not the accent. Read from the sources: the sheets need the
 * host to render.
 */
const root = join(import.meta.dir, "..")
const read = (file: string) => readFileSync(join(root, file), "utf8")

const SHEETS = [
  { tsx: "decisions/decisions-sheet.tsx", css: "decisions/decisions.css" },
  { tsx: "design/design-sheet.tsx", css: "design/design.css" },
]

describe("the sheets' stepper is for two items or more (DS2-6)", () => {
  for (const { tsx, css } of SHEETS) {
    test(`${tsx}: the steps are drawn only when there is more than one item`, () => {
      const source = read(tsx)
      const at = source.indexOf('data-slot="sheet-steps"')
      expect(at).toBeGreaterThan(0)
      // The nearest `<Show when=` above the steps decides when they exist.
      const guard = /<Show when=\{([^}]*)\}>/g
      let last = ""
      for (const match of source.slice(0, at).matchAll(guard)) last = match[1]!
      expect(last).toBe("open().length > 1")
    })

    test(`${css}: the current step is ink, not the accent`, () => {
      let value: string | undefined
      postcss.parse(read(css)).walkRules((rule) => {
        if (rule.selector.trim() !== '[data-slot="sheet-steps"] i[data-on]') return
        rule.walkDecls("background", (decl) => {
          value = decl.value
        })
      })
      expect(value).toBe("var(--ade-text)")
    })
  }
})
