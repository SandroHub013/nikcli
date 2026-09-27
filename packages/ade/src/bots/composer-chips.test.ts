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
    for (const piece of [
      "<ModelPicker",
      "<ChipMenu",
      "<EffortPicker",
      "onChoose={chooseModel}",
      "onChoose={chooseEffort}",
      'data-slot="bots-composer-cap"',
      'type="submit"',
    ])
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

/* Review of bot-riquadro, b: the bot's Invia was the form's full teal button, the Chat's was not. */
describe("lint: the bot's Invia", () => {
  const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "")
  const bots = strip(readFileSync(join(import.meta.dir, "bots.css"), "utf8"))
  const chat = strip(readFileSync(join(import.meta.dir, "..", "chat", "chat.css"), "utf8"))
  const body = (css: string, selector: string) => {
    const start = css.indexOf(`${selector} {`)
    expect(start).toBeGreaterThan(-1)
    return css
      .slice(css.indexOf("{", start) + 1, css.indexOf("}", start))
      .replace(/\s+/g, " ")
      .trim()
  }

  test("lint: the bot's and the room's Invia are the Chat's, not the form's primary button", () => {
    const rooms = readFileSync(join(import.meta.dir, "room-panel.tsx"), "utf8")
    const roomStart = rooms.indexOf('data-slot="bots-composer"')
    expect(roomStart).toBeGreaterThan(-1)
    // The room's composer only: the room form's «Crea» stays the form's primary button.
    const roomComposer = rooms.slice(roomStart, rooms.indexOf("</form>", roomStart))
    for (const view of [slice('<div data-slot="bots-composer-row">', "</form>"), roomComposer]) {
      expect(view).toContain('type="submit" data-slot="bots-send"')
      expect(view).not.toContain('type="submit" data-slot="bots-btn" data-tone="primary"')
    }
    for (const state of ["", ":disabled"]) {
      expect(body(bots, `[data-slot="bots-send"]${state}`)).toBe(body(chat, `[data-slot="chat-send"]${state}`))
    }
  })

  test("lint: no teal on either Invia: no --ade-accent in any of their rules, at rest, hovered or focused", () => {
    const rules = (css: string, slot: string) => {
      const found = [...css.matchAll(new RegExp(`\\[data-slot="${slot}"\\][^{]*\\{[^}]*\\}`, "g"))].map(
        (match) => match[0],
      )
      expect(found.length).toBeGreaterThan(0)
      return found
    }
    for (const rule of [...rules(bots, "bots-send"), ...rules(chat, "chat-send")]) {
      expect([rule, rule.includes("--ade-accent")]).toEqual([rule, false])
      // The focus ring is the shared grey token since contorni-neutri; only the accent is barred.
    }
    expect(body(bots, '[data-slot="bots-send"]')).toContain("background: var(--ade-text);")
  })
})
