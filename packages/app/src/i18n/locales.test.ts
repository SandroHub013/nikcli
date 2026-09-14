import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { LOCALES } from "./locales"

/**
 * The shipped list and the dictionary files on disk have to name the same set.
 *
 * The loader map needs no test: it is declared `Record<Exclude<Locale, "en">, …>`
 * and `Locale` now derives from this list, so a locale added here fails to
 * compile until the loader gains an entry. Files on disk are what types cannot
 * see, so that is what this checks.
 */
const files = readdirSync(new URL(".", import.meta.url))
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => name.slice(0, -3))
  .filter((name) => name !== "locales" && name !== "untranslated" && name !== "en")

describe("locale lists agree", () => {
  test("every dictionary file is in the shipped list", () => {
    expect([...files].sort()).toEqual([...LOCALES].sort())
  })

  test("the shipped list excludes English, which is the source the others fall back to", () => {
    expect(LOCALES as readonly string[]).not.toContain("en")
  })

  test("no locale appears twice", () => {
    expect(new Set(LOCALES).size).toBe(LOCALES.length)
  })
})
