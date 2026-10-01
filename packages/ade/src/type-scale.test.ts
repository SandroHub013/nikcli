import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Glob } from "bun"

/*
 * Polish B1: text sizes come from the type scale in index.css (--ade-font-*),
 * never from a pixel written in place. There were 108 of them, half pixels
 * among them (10.5, 11.5, 12.5, 13.5), and nothing to change them together.
 * The user chose the compact density (DS-B = 1): text that is read, rather
 * than scanned, is --ade-font-body, 12px.
 */
const dir = import.meta.dir
const sheets = [...new Glob("**/*.css").scanSync(dir)].map((file) => ({
  file,
  text: readFileSync(join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
}))

/**
 * Where a size in px is meant, with why. Keyed by `file` and the declaration
 * as written, spaces folded. A new one needs its reason here.
 */
const EXCEPTIONS: Record<string, string> = {
  'simulator/simulator-pane.css: font: var(--ade-weight-semibold) 15px/1 -apple-system, "Segoe UI", system-ui, sans-serif':
    "the simulated phone status bar draws the device own, at the device size; it is not ADE text",
}

/** Every `font-size` or `font` declaration in the stylesheets that sets a size in px. */
function pixelSizes(): string[] {
  const found: string[] = []
  for (const { file, text } of sheets) {
    for (const match of text.matchAll(/(?:^|[;{\s])(font-size|font)\s*:\s*([^;}]*)/g)) {
      const value = match[2]!.trim().replace(/\s+/g, " ")
      if (!/(?:^|[\s(/])\d+(?:\.\d+)?px\b/.test(value)) continue
      const key = `${file.replaceAll("\\", "/")}: ${match[1]}: ${value}`
      if (!(key in EXCEPTIONS)) found.push(key)
    }
  }
  return found
}

describe("the type scale (polish B1)", () => {
  test("no stylesheet under src writes a text size in px", () => {
    expect(pixelSizes()).toEqual([])
  })

  test("every exception still exists, and says why", () => {
    const all = sheets.flatMap(({ file, text }) =>
      [...text.matchAll(/(?:^|[;{\s])(font-size|font)\s*:\s*([^;}]*)/g)].map(
        (match) => `${file.replaceAll("\\", "/")}: ${match[1]}: ${match[2]!.trim().replace(/\s+/g, " ")}`,
      ),
    )
    for (const [key, why] of Object.entries(EXCEPTIONS)) {
      expect(all).toContain(key)
      expect(why.length).toBeGreaterThan(10)
    }
  })

  test("the scale has whole pixels only, and the reading size is 12px", () => {
    const index = sheets.find((sheet) => sheet.file === "index.css")!.text
    const scale = [...index.matchAll(/--ade-font-([\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]!.trim()])
    expect(scale.length).toBeGreaterThanOrEqual(8)
    for (const [, value] of scale) expect(value).toMatch(/^\d+px$/)
    expect(Object.fromEntries(scale).body).toBe("12px")
  })

  test("card bodies, messages, lists and the sidebar read at the body size", () => {
    const uses = (file: string, selector: string) => {
      const text = sheets.find((sheet) => sheet.file.replaceAll("\\", "/") === file)!.text
      const at = text.indexOf(`${selector} {`)
      expect(`${file} ${selector}: ${at >= 0}`).toBe(`${file} ${selector}: true`)
      return text.slice(at, text.indexOf("}", at))
    }
    expect(uses("decisions/decisions.css", '[data-slot="decision-card"]')).toContain("var(--ade-font-body)")
    expect(uses("design/design.css", '[data-slot="design-card"]')).toContain("var(--ade-font-body)")
    expect(uses("bots/bots.css", '[data-slot="bots-msg-text"]')).toContain("var(--ade-font-body)")
    expect(uses("index.css", '[data-slot="session-row"]')).toContain("var(--ade-font-body)")
    expect(uses("grid/pane.css", '[data-slot="pane-transcript"]')).toContain("var(--ade-font-body)")
  })
})
