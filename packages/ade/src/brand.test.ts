import { describe, expect, test } from "bun:test"
import { checkConfigs, copyrightLine, derived, drift, readBrand } from "./brand"

/*
 * The brand lives in brand.json and is written into the Tauri configs by
 * `bun run brand`. A config edited by hand would outlive a rename in silence;
 * this is what stops that.
 */
describe("the brand", () => {
  test("is one file, and the Tauri configs carry exactly what it says", () => {
    expect(checkConfigs(readBrand(), new Date().getFullYear())).toEqual([])
  })

  test("names the publisher alone in the copyright, over the years since the first one", () => {
    const brand = { ...readBrand(), publisher: "someone", since: 2025 }
    expect(copyrightLine(brand, 2025)).toBe("© 2025 someone")
    expect(copyrightLine(brand, 2027)).toBe("© 2025-2027 someone")
  })

  test("derives the product name, the publisher, the descriptions and the test name", () => {
    const brand = readBrand()
    const wanted = derived(brand, 2026)
    expect(wanted.main.productName).toBe(brand.name)
    expect(wanted.main["bundle.publisher"]).toBe(brand.publisher)
    expect(wanted.main["bundle.shortDescription"]).toBe(brand.tagline)
    expect(wanted.test.productName).toBe(`${brand.name} Test`)
  })

  test("reports each field that drifted, and nothing when none did", () => {
    const wanted = { productName: "X", "bundle.publisher": "Y" }
    expect(drift({ productName: "X", bundle: { publisher: "Y" } }, wanted)).toEqual([])
    expect(drift({ productName: "X", bundle: { publisher: "Z" } }, wanted)).toEqual(['bundle.publisher: "Z" → "Y"'])
    expect(drift({}, wanted)).toHaveLength(2)
  })
})
