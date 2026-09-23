import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { asBrand, BRAND, copyrightLine, derived, drift, type Json } from "./brand"

/*
 * The brand lives in brand.json and is written into the Tauri configs by
 * `bun run brand`. A config edited by hand would outlive a rename in silence;
 * this is what stops that. Nothing here reads the clock.
 */
const TAURI = join(import.meta.dir, "..", "src-tauri")
const config = (file: string) => JSON.parse(readFileSync(join(TAURI, file), "utf8")) as Json

describe("the brand", () => {
  test("is one file, and the Tauri configs carry exactly what it says", () => {
    const wanted = derived(BRAND)
    expect(drift(config("tauri.conf.json"), wanted.main)).toEqual([])
    expect(drift(config("tauri.test.conf.json"), wanted.test)).toEqual([])
  })

  test("names the publisher alone in the copyright, over the years it declares", () => {
    const brand = { ...BRAND, publisher: "someone", since: 2025 }
    expect(copyrightLine({ ...brand, until: 2025 })).toBe("© 2025 someone")
    expect(copyrightLine({ ...brand, until: 2027 })).toBe("© 2025-2027 someone")
  })

  test("refuses a brand with a field missing or the years reversed", () => {
    expect(() => asBrand({ ...BRAND, name: "" })).toThrow('missing "name"')
    expect(() => asBrand({ ...BRAND, until: 2024 })).toThrow("before since")
  })

  test("derives the product name, the publisher, the descriptions and the test name", () => {
    const wanted = derived(BRAND)
    expect(wanted.main.productName).toBe(BRAND.name)
    expect(wanted.main["bundle.publisher"]).toBe(BRAND.publisher)
    expect(wanted.main["bundle.shortDescription"]).toBe(BRAND.tagline)
    expect(wanted.test.productName).toBe(`${BRAND.name} Test`)
  })

  test("reports each field that drifted, and nothing when none did", () => {
    const wanted = { productName: "X", "bundle.publisher": "Y" }
    expect(drift({ productName: "X", bundle: { publisher: "Y" } }, wanted)).toEqual([])
    expect(drift({ productName: "X", bundle: { publisher: "Z" } }, wanted)).toEqual(['bundle.publisher: "Z" → "Y"'])
    expect(drift({}, wanted)).toHaveLength(2)
  })
})
