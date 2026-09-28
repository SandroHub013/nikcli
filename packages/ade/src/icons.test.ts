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
      expect(rule.body).toMatch(/height:\s*var\(--ade-icon-size\)/)
      if (!/--ade-icon-dot\b/.test(rule.body)) expect(rule.body).toMatch(/width:\s*var\(--ade-icon-size\)/)
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

/*
 * Polish B5b, from Verifiche's screenshots of B5: in the top bar each dot
 * took 10px more than the «·» it replaced, with a bigger dot; the quota's
 * «!» stood 9.6px tall beside digits of 6.4.
 */
describe("the icons fit the text they sit in (polish B5b)", () => {
  /** The vertical extent of an icon's ink, in its 12-unit box: strokes with round caps, and filled circles. */
  const ink = (name: string) => {
    const svg = decodeURIComponent(
      new RegExp(`--ade-icon-${name}:\\s*url\\("data:image/svg\\+xml,([^"]+)"\\);`).exec(index)![1]!,
    )
    const ys: number[] = []
    for (const path of svg.matchAll(/<path d='M([\d.]+) ([\d.]+)v([\d.-]+)'/g)) {
      const from = Number(path[2])
      const to = from + Number(path[3])
      ys.push(Math.min(from, to) - 0.75, Math.max(from, to) + 0.75)
    }
    for (const circle of svg.matchAll(/<circle cx='[\d.]+' cy='([\d.]+)' r='([\d.]+)'/g)) {
      ys.push(Number(circle[1]) - Number(circle[2]), Number(circle[1]) + Number(circle[2]))
    }
    return { top: Math.min(...ys), bottom: Math.max(...ys), height: Math.max(...ys) - Math.min(...ys) }
  }

  test("a separator dot takes the room of the «·»: a 2px box, the mask at its 12px scale, about 1px of ink", () => {
    expect(index).toMatch(/--ade-icon-dot-width:\s*2px;/)
    const dots = pseudoRules().filter((rule) => /mask:\s*var\(--ade-icon-dot\)/.test(rule.body))
    expect(dots.map((rule) => rule.file).sort()).toEqual(["dev.css", "grid/pane.css"])
    for (const rule of dots) {
      expect(rule.body).toMatch(/width:\s*var\(--ade-icon-dot-width\)/)
      expect(rule.body).toMatch(/mask:\s*var\(--ade-icon-dot\) center \/ var\(--ade-icon-size\) no-repeat/)
    }
    expect(ink("dot").height).toBeLessThanOrEqual(1.4)
  })

  test("the quota's «!» is as tall as the digits beside it, not taller", () => {
    const alert = ink("alert")
    // Digits at --ade-font-xs are 6.4px of ink; the icon's box is drawn at 1:1.
    expect(alert.height).toBeGreaterThanOrEqual(5.5)
    expect(alert.height).toBeLessThanOrEqual(7)
    // Its stem and its point do not touch.
    const svg = decodeURIComponent(/--ade-icon-alert:\s*url\("data:image\/svg\+xml,([^"]+)"\);/.exec(index)![1]!)
    const stem = /<path d='M[\d.]+ ([\d.]+)v([\d.]+)'/.exec(svg)!
    const point = /<circle cx='[\d.]+' cy='([\d.]+)' r='([\d.]+)'/.exec(svg)!
    expect(Number(point[1]) - Number(point[2]) - (Number(stem[1]) + Number(stem[2]) + 0.75)).toBeGreaterThan(0.5)
  })

  test("no rule is left for pane-agent or pane-state, which no pane writes any more", () => {
    const tsx = [...new Glob("**/*.tsx").scanSync(dir)].map((file) => readFileSync(join(dir, file), "utf8")).join("\n")
    for (const slot of ["pane-agent", "pane-state"]) {
      expect(tsx).not.toContain(`data-slot="${slot}"`)
      const left = sheets.filter((sheet) => sheet.text.includes(`[data-slot="${slot}"]`)).map((sheet) => sheet.file)
      expect(`${slot}: ${left.join(", ")}`).toBe(`${slot}: `)
    }
  })
})
