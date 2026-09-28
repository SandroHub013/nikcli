import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Glob } from "bun"

/*
 * Polish B5: the marks a ::before or ::after took from the font (✓ ✕ ▸ ▾ ! ·)
 * come from one set of line icons with a 1.5px stroke (DS-C = 1), painted in
 * the text's colour through a mask. Read from the sources.
 */
const dir = import.meta.dir
const sheets = [...new Glob("**/*.css").scanSync(dir)].map((file) => ({
  file: file.replaceAll("\\", "/"),
  text: readFileSync(join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
}))
const GLYPHS = /[✓✔✕✗✖▸▶▾▼!·•]/

/** The rules on a ::before or ::after, with their body. */
function pseudoRules(): { file: string; selector: string; body: string }[] {
  const rules: { file: string; selector: string; body: string }[] = []
  for (const { file, text } of sheets) {
    for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim().replace(/\s+/g, " ")
      if (/::?(before|after)\b/.test(selector)) rules.push({ file, selector, body: match[2]! })
    }
  }
  return rules
}

const NAMES = ["check", "cross", "chevron-right", "chevron-down", "alert", "dot"]
const index = sheets.find((sheet) => sheet.file === "index.css")!.text

describe("the icons (polish B5)", () => {
  test("no ::before or ::after draws ✓ ✕ ▸ ▾ ! or · from the font", () => {
    const glyphs = pseudoRules()
      .filter((rule) => [...rule.body.matchAll(/content:\s*([^;]*)/g)].some((content) => GLYPHS.test(content[1]!)))
      .map((rule) => `${rule.file}: ${rule.selector}`)
    expect(glyphs).toEqual([])
  })

  test("one set in index.css: 12×12 line icons with a 1.5px stroke, at a 12px box", () => {
    expect(index).toMatch(/--ade-icon-size:\s*12px;/)
    for (const name of NAMES) {
      const icon = new RegExp(`--ade-icon-${name}:\\s*url\\("data:image/svg\\+xml,([^"]+)"\\);`).exec(index)?.[1]
      expect(`${name}: ${Boolean(icon)}`).toBe(`${name}: true`)
      expect(icon).toContain("viewBox='0 0 12 12'")
      expect(icon).toContain("stroke-width='1.5'")
      expect(icon).toContain("fill='none'")
      // A data: URL in CSS: no raw «<», «>» or «#».
      expect(icon).not.toMatch(/[<>#]/)
    }
  })

  test("an icon takes its text's colour: painted with currentColor through the mask", () => {
    const drawn = pseudoRules().filter((rule) => /mask:\s*var\(--ade-icon-/.test(rule.body))
    expect(drawn.length).toBeGreaterThanOrEqual(5)
    for (const rule of drawn) {
      expect(`${rule.file}: ${rule.selector}: ${/background-color:\s*currentColor/.test(rule.body)}`).toBe(
        `${rule.file}: ${rule.selector}: true`,
      )
      expect(rule.body).toMatch(/content:\s*""/)
      expect(rule.body).toMatch(/width:\s*var\(--ade-icon-size\)/)
    }
    // The second state of a two-state mark swaps the mask only.
    const swaps = pseudoRules().filter((rule) => /mask-image:\s*var\(--ade-icon-/.test(rule.body))
    expect(swaps.map((rule) => rule.body.match(/--ade-icon-[\w-]+/)![0]).sort()).toEqual([
      "--ade-icon-chevron-down",
      "--ade-icon-cross",
    ])
  })

  test("every icon of the set is used", () => {
    const used = sheets
      .filter((sheet) => sheet.file !== "index.css")
      .map((sheet) => sheet.text)
      .join("\n")
    for (const name of NAMES) expect(`${name}: ${used.includes(`var(--ade-icon-${name})`)}`).toBe(`${name}: true`)
  })
})
