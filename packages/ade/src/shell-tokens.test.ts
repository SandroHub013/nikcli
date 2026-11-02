import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Glob } from "bun"

/*
 * DS-4, DS-12 and DS-13 (2026-11-02 audit).
 *
 * DS-4: the sidebar and the panes are the two most visible shapes in the app
 * and did not line up: the sidebar sat 4px below the first pane, and its
 * corners were 20px against the panes' 18. Both read `--ade-shell-radius` and
 * `--ade-shell-gutter` now.
 * DS-12: the two shell shadows were near-duplicates typed by hand; the toast
 * and the browser's two floating shadows bypassed the elevation scale.
 * DS-13: z-index had no scale: 14 literals, the screenshot viewer (120) above
 * dialogs (100), the order decided per sheet. The scale keeps the values the
 * app already stacks by, so no layer moved, and gives each a name.
 */
const dir = import.meta.dir
const sheets = [...new Glob("**/*.css").scanSync(dir)].map((file) => ({
  file: file.replaceAll("\\", "/"),
  text: readFileSync(join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
}))
const index = sheets.find((sheet) => sheet.file === "index.css")!.text
const sidebar = sheets.find((sheet) => sheet.file === "sidebar/sidebar.css")!.text
const pane = sheets.find((sheet) => sheet.file === "grid/pane.css")!.text
const browser = sheets.find((sheet) => sheet.file === "browser/browser.css")!.text

function value(name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(index)
  if (!match) throw new Error(`${name} is not declared in index.css`)
  return match[1]!.trim().replace(/\s+/g, " ")
}

describe("the z-index scale (DS-13)", () => {
  test("no sheet writes a z-index as a number", () => {
    const literal = sheets.flatMap(({ file, text }) =>
      [...text.matchAll(/(?:^|[;{\s])z-index\s*:\s*([^;}]*)/g)]
        .map((match) => match[1]!.trim())
        .filter((v) => !/^var\(--ade-z-[a-z0-9-]+\)$/.test(v))
        .map((v) => `${file}: z-index: ${v}`),
    )
    expect(literal).toEqual([])
  })

  test("the scale keeps the order the app stacks by", () => {
    const order = ["base", "above", "over", "raised", "lifted", "hover", "sticky", "popover", "dropdown", "bar", "overlay", "toast", "viewer", "splash"]
    const values = order.map((name) => Number(value(`--ade-z-${name}`)))
    expect(values).toEqual([1, 2, 3, 5, 6, 10, 20, 30, 40, 60, 100, 110, 120, 1000])
  })

  test("the screenshot viewer, the toast and the splash sit over the dialogs", () => {
    const [overlay, toast, viewer, splash] = ["overlay", "toast", "viewer", "splash"].map((n) => Number(value(`--ade-z-${n}`)))
    expect(toast).toBeGreaterThan(overlay!)
    expect(viewer).toBeGreaterThan(toast!)
    expect(splash).toBeGreaterThan(viewer!)
  })
})

describe("the shell geometry (DS-4)", () => {
  test("one radius and one gutter", () => {
    expect(value("--ade-shell-radius")).toBe("18px")
    expect(value("--ade-shell-gutter")).toBe("10px")
  })

  test("the sidebar and the pane shell read them", () => {
    expect(sidebar).toMatch(/aside\[data-component="ade-sidebar"\]\s*\{[^}]*margin:\s*var\(--ade-shell-gutter\)/)
    expect(sidebar).toMatch(/aside\[data-component="ade-sidebar"\]\s*\{[^}]*border-radius:\s*var\(--ade-shell-radius\)/)
    expect(index).toMatch(/\[data-slot="grid-cell"\] > \[data-component\]\s*\{[^}]*border-radius:\s*var\(--ade-shell-radius\)/)
    expect(index).toMatch(/\[data-component="session-grid"\]\s*\{[^}]*gap:\s*var\(--ade-shell-gutter\)[^}]*padding:\s*var\(--ade-shell-gutter\)/)
  })

  test("the drop zone has the pane's corners", () => {
    expect(index).not.toMatch(/border-radius:\s*18px/)
  })
})

describe("the shell shadows (DS-12)", () => {
  test("the shell and its focus have a token each", () => {
    expect(value("--ade-shadow-shell")).toMatch(/^0 3px 10px light-dark\(rgba/)
    expect(value("--ade-shadow-shell-focus")).toMatch(/var\(--ade-border-strong\), 0 8px 24px light-dark\(rgba/)
  })

  /*
   * `light-dark()` takes two colours and nothing else. A custom property accepts any text, so a token that wrapped a
   * whole shadow (`light-dark(0 3px 10px rgba(...), 0 3px 10px rgba(...))`) declared without complaint and then made
   * every `box-shadow` that read it invalid at computed-value time, which is `none`: the sidebar, the resting panes,
   * the toast and the pill ring drew nothing (the review of this branch, B1; `-sm/-md/-lg` since 2026-08-21). The
   * suite reads CSS as text, so the validity is checked here by rule.
   */
  const COLOUR = /^(#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|color-mix|oklch|oklab|color)\(|var\(|transparent|currentcolor)/i

  /** The two arguments of every `light-dark(` in `text`, honouring nested parentheses. */
  function lightDarkArgs(text: string): string[][] {
    const found: string[][] = []
    for (let at = text.indexOf("light-dark("); at >= 0; at = text.indexOf("light-dark(", at + 1)) {
      let depth = 0
      let start = at + "light-dark(".length
      const args: string[] = []
      for (let i = start; i < text.length; i++) {
        const c = text[i]
        if (c === "(") depth++
        else if (c === ")") {
          if (depth === 0) {
            args.push(text.slice(start, i).trim())
            break
          }
          depth--
        } else if (c === "," && depth === 0) {
          args.push(text.slice(start, i).trim())
          start = i + 1
        }
      }
      found.push(args)
    }
    return found
  }

  test("light-dark() is given two colours wherever it is written under src", () => {
    const bad = sheets.flatMap(({ file, text }) =>
      lightDarkArgs(text)
        .filter((args) => args.length !== 2 || args.some((arg) => !COLOUR.test(arg)))
        .map((args) => `${file}: light-dark(${args.join(", ")})`),
    )
    expect(bad).toEqual([])
  })

  test("every shadow token is a valid box-shadow once its light-dark() colours are resolved", () => {
    const LENGTH = /^-?\d*\.?\d+(px)?$/
    for (const name of ["sm", "md", "lg", "shell", "shell-focus"]) {
      const resolved = value(`--ade-shadow-${name}`).replace(/light-dark\(\s*((?:[^(),]|\([^()]*\))+),[^]*?\)(?=,|$)/g, "$1")
      // Split the layers on top-level commas.
      const layers: string[] = []
      let depth = 0
      let from = 0
      for (let i = 0; i < resolved.length; i++) {
        if (resolved[i] === "(") depth++
        else if (resolved[i] === ")") depth--
        else if (resolved[i] === "," && depth === 0) {
          layers.push(resolved.slice(from, i).trim())
          from = i + 1
        }
      }
      layers.push(resolved.slice(from).trim())
      for (const layer of layers) {
        // Tokens at top level: lengths, an optional inset, and one colour (a function, a hex or a var).
        const parts = layer.match(/(?:[^\s(]+\([^()]*(?:\([^()]*\)[^()]*)*\)|\S+)/g) ?? []
        const lengths = parts.filter((part) => LENGTH.test(part))
        const colours = parts.filter((part) => COLOUR.test(part))
        const rest = parts.filter((part) => !LENGTH.test(part) && !COLOUR.test(part) && part !== "inset")
        expect({ name, layer, lengths: lengths.length >= 2 && lengths.length <= 4, colours: colours.length, rest }).toEqual({
          name,
          layer,
          lengths: true,
          colours: 1,
          rest: [],
        })
      }
    }
  })

  test("the sidebar and the pane use them, not their own copies", () => {
    expect(sidebar).toMatch(/aside\[data-component="ade-sidebar"\]\s*\{[^}]*box-shadow:\s*var\(--ade-shadow-shell\)/)
    expect(index).toMatch(/box-shadow:\s*var\(--ade-pane-shadow,\s*var\(--ade-shadow-shell\)\)/)
    expect(pane).toMatch(/--ade-pane-shadow:\s*var\(--ade-shadow-shell-focus\)/)
  })

  test("the toast and the browser's floating shadows come from the scale", () => {
    expect(pane).toMatch(/\[data-slot="pane-toast"\]\s*\{[^}]*box-shadow:\s*var\(--ade-shadow-md\)/)
    expect(browser).not.toMatch(/box-shadow:\s*0 (8|12)px/)
  })

  test("the browser sheet has no drafting notes left", () => {
    expect(readFileSync(join(dir, "browser/browser.css"), "utf8")).not.toMatch(/wait, rule says|Let's just|better to use something tokenized/)
  })
})
