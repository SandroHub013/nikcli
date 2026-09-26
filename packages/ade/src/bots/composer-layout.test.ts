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
  test("the field keeps a width to write in", () => {
    const field = rule("bots-composer-field")
    expect(field["min-width"]).toMatch(/rem/)
    expect(field["flex"]).toBe("1 1 auto")
  })

  test("in a narrow thread the caption has a line of its own, and the field the one above", () => {
    // 14rem is 168 px here: the root font is 12 px, and beside a caption of seven lines that was the field.
    expect(rule("bots-thread")["container-type"]).toBe("inline-size")
    const narrow = /@container \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/.exec(css)
    expect(narrow).not.toBeNull()
    expect(Number(narrow![1])).toBeGreaterThanOrEqual(560)
    const inside = (slot: string) => {
      const match = new RegExp(`\\[data-slot="${slot}"\\]\\s*\\{([^}]*)\\}`).exec(narrow![2]!)
      return match?.[1] ?? ""
    }
    expect(inside("bots-composer")).toContain("flex-wrap: wrap")
    expect(inside("bots-composer-field")).toContain("flex-basis: 0")
    // After the button, on the whole line.
    expect(inside("bots-composer-cap")).toContain("order: 1")
    expect(inside("bots-composer-cap")).toContain("flex-basis: 100%")
    expect(inside("bots-composer-cap")).toContain("max-width: none")
  })

  test("the caption gives way: it shrinks, wraps and has a ceiling", () => {
    const cap = rule("bots-composer-cap")
    expect(cap["flex"]).toBe("0 1 auto")
    expect(cap["min-width"]).toBe("0")
    expect(cap["max-width"]).toBeDefined()
    expect(cap["white-space"]).toBeUndefined()
  })
})

/* Verifiche: «0/2200 caratteriVuoto.» in the Memory section, the count and «Vuoto.» on one line. */
describe("the Memory section's blocks", () => {
  test("stack the count above the entries or «Vuoto.»", () => {
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
    expect(focused).toContain("box-shadow: 0 0 0 2px")
    expect([focused, focused.includes("--ade-focus-ring")]).toEqual([focused, false])
    const field = /\[data-slot="bots-composer-field"\]:focus\s*\{([^}]*)\}/.exec(css)?.[1] ?? ""
    expect(field).toContain("box-shadow: none")
    expect(field).toContain("outline: none")
  })
})
