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

  test("the caption gives way: it shrinks, wraps and has a ceiling", () => {
    const cap = rule("bots-composer-cap")
    expect(cap["flex"]).toBe("0 1 auto")
    expect(cap["min-width"]).toBe("0")
    expect(cap["max-width"]).toBeDefined()
    expect(cap["white-space"]).toBeUndefined()
  })
})
