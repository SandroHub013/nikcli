import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * Composer-chip, pezzo 4: the bot's model and effort are chips in the
 * composer's box. What a choice writes is proved on the functions
 * (`composer.test.ts`); these lints check that the thread is wired to them
 * and to the form's save.
 */
const view = readFileSync(join(import.meta.dir, "bots.tsx"), "utf8")

function slice(from: string, to: string, after = 0): string {
  const start = view.indexOf(from, after)
  expect(start).toBeGreaterThan(-1)
  const end = view.indexOf(to, start)
  expect(end).toBeGreaterThan(start)
  return view.slice(start, end)
}

describe("the bot's composer", () => {
  test("lint: the model and effort chips sit in the row under the field, before Invia", () => {
    const row = slice('<div data-slot="bots-composer-row">', "</form>")
    for (const piece of ["<ModelPicker", "<ChipMenu", "<EffortPicker", "onChoose={chooseModel}", "onChoose={chooseEffort}", 'data-slot="bots-composer-cap"', 'type="submit"'])
      expect(row).toContain(piece)
    expect(row.indexOf("<EffortPicker")).toBeLessThan(row.indexOf('type="submit"'))
    // The field first, the row under it, in the same form.
    const form = slice('data-slot="bots-composer"\n', "</form>")
    expect(form.indexOf('data-slot="bots-composer-field"')).toBeGreaterThan(-1)
    expect(form.indexOf('data-slot="bots-composer-field"')).toBeLessThan(form.indexOf('data-slot="bots-composer-row"'))
  })

  test("lint: a chip's choice is saved as the form saves, and the model chip reads the catalog when it opens", () => {
    const thread = slice("<Thread\n", "/>")
    expect(thread).toContain("onSettings={async (changes) => {")
    expect(thread).toContain("await updateBot(bot(), changes)")
    expect(thread).toContain("reload()")
    const row = slice('<div data-slot="bots-composer-row">', "</form>")
    expect(row).toContain("onOpen={() => props.catalog?.open()}")
    expect(view).toContain("void change(modelChange(value, effort(), variants))")
    expect(view).toContain("void change(effortChange(value))")
  })
})
