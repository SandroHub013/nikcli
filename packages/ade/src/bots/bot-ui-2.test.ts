import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * The second page of choices (design/ade-bot-2, the user's answers of 2026-10-16). What is layout is held as rules on
 * the source, since `bots.tsx` cannot be rendered under `bun test`; what has a rule in it lives in a `.ts` and is
 * tested there.
 */
const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8")
const tsx = read("bots.tsx")
const css = read("bots.css").replace(/\/\*[\s\S]*?\*\//g, "")

describe("3. the bots' list: every bot a row alike", () => {
  test("no three large ones at the top: each bot is a row, in the order of last use", () => {
    expect(tsx).not.toContain('data-slot="bots-pinned"')
    expect(tsx).not.toContain('data-slot="bots-pin"')
    const list = tsx.slice(tsx.indexOf('<div data-slot="bots-list">'))
    expect(list).toMatch(/^<div data-slot="bots-list">\s*<For each=\{ordered\(\)\}>/)
    // The row keeps the last thing said and when.
    expect(list).toContain("lastLine(talk()")
    expect(list).toContain("formatWhen(talk().updatedAt, now())")
    expect(css).not.toContain('[data-slot="bots-pin')
  })
})
