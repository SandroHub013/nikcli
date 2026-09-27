import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * The bot's composer: a long caption must not squeeze the field (Verifiche,
 * the field down to one column beside «ultimo turno openrouter/…:free · …»).
 * Held as rules, since the layout is the stylesheet's.
 */
const css = readFileSync(join(import.meta.dir, "bots.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")

function rule(slot: string): Record<string, string> {
  const match = new RegExp(`\\[data-slot="${slot}"\\]\\s*\\{([^}]*)\\}`).exec(css)
  if (!match) throw new Error(`no rule for ${slot}`)
  return Object.fromEntries(
    match[1]!
      .split(";")
      .map((line) => line.split(":").map((part) => part.trim()))
      .filter((pair) => pair.length >= 2 && pair[0])
      .map(([key, ...value]) => [key!, value.join(":")]),
  )
}

describe("the bot's composer", () => {
  // Since pezzo 4 the box is a column: the field on top, the chips, the caption and Invia in a row under it.
  test("lint: the field has the box's whole line to write in, over the row", () => {
    expect(rule("bots-composer")["flex-direction"]).toBe("column")
    const field = rule("bots-composer-field")
    expect(field["width"]).toBe("100%")
    expect(field["flex"]).toBe("0 0 auto")
    expect(rule("bots-composer-row")["flex-wrap"]).toBe("wrap")
  })

  test("lint: in a narrow thread the caption has a line of its own under the chips, and the chips give way", () => {
    // 14rem is 168 px here: the root font is 12 px, and beside a caption of seven lines that was the field.
    expect(rule("bots-thread")["container-type"]).toBe("inline-size")
    const narrow = /@container \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/.exec(css)
    expect(narrow).not.toBeNull()
    expect(Number(narrow![1])).toBeGreaterThanOrEqual(560)
    const inside = (slot: string) => {
      const match = new RegExp(`\\[data-slot="${slot}"\\]\\s*\\{([^}]*)\\}`).exec(narrow![2]!)
      return match?.[1] ?? ""
    }
    expect(narrow![2]).toContain('[data-slot="bots-composer-row"] [data-slot="chip"]')
    expect(narrow![2]).toContain("max-width: 12rem")
    // After the button, on the whole line.
    expect(inside("bots-composer-cap")).toContain("order: 1")
    expect(inside("bots-composer-cap")).toContain("flex-basis: 100%")
    expect(inside("bots-composer-cap")).toContain("max-width: none")
  })

  test("lint: the caption gives way: it shrinks, wraps and has a ceiling", () => {
    const cap = rule("bots-composer-cap")
    expect(cap["flex"]).toBe("0 1 auto")
    expect(cap["min-width"]).toBe("0")
    expect(cap["max-width"]).toBeDefined()
    expect(cap["white-space"]).toBeUndefined()
  })
})

/* Verifiche: «0/2200 caratteriVuoto.» in the Memory section, the count and «Vuoto.» on one line. */
describe("the Memory section's blocks", () => {
  test("lint: the Memory section's blocks stack, so the count and «Vuoto.» land on one line", () => {
    const memory = readFileSync(join(import.meta.dir, "memory-panel.tsx"), "utf8")
    expect(memory).toContain('<section data-slot="bots-card-section">')
    expect(memory).toContain('<div data-slot="gateway-block">')
    const block = /([^{}]*\[data-slot="bots-card-section"\] > \[data-slot="gateway-block"\][^{}]*)\{([^}]*)\}/.exec(css)
    expect(block).not.toBeNull()
    expect(block![2]).toContain("display: flex")
    expect(block![2]).toContain("flex-direction: column")
  })
})

/* bot-sforzo, A occhio: two focus rings, the composer's and the global one on the
   field. Since composer-nero the ring is grey, so this checks the composer's own
   and that it is the neutral one: the accent ring is gone, the field still draws
   none of its own. */
describe("lint: the composer's focus", () => {
  test("lint: one ring, the composer's, and it is grey: the field draws none of its own", () => {
    expect(rule("bots-composer")).toBeDefined()
    const focused = /\[data-slot="bots-composer"\]:focus-within\s*\{([^}]*)\}/.exec(css)?.[1] ?? ""
    // The shared grey ring (contorni-terzo, 1): the mix of --ade-border-strong it had was under 3:1.
    expect(focused).toContain("box-shadow: var(--ade-focus-ring)")
    const field = /\[data-slot="bots-composer-field"\]:focus\s*\{([^}]*)\}/.exec(css)?.[1] ?? ""
    expect(field).toContain("box-shadow: none")
    expect(field).toContain("outline: none")
  })
})
