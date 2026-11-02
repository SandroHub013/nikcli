import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * What the live test of 2026-11-02 found in the look of ADE (V1 to V9), pinned where a rule can be: the stylesheets
 * themselves. What cannot be pinned here (the pixels) is for the eyes: the report says which.
 */
const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf-8").replace(/\r\n/g, "\n")
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "")

/** The declarations of every rule whose selector is exactly `selector`, comments out. */
function rule(sheet: string, selector: string): string {
  const text = code(sheet)
  const found: string[] = []
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`(^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "gm")
  for (const match of text.matchAll(pattern)) found.push(match[2]!)
  return found.join("\n")
}

describe("V1: the terminal's gutter", () => {
  const pane = read("grid/pane.css")

  test("is padding on the emulator's own element, which is what FitAddon takes off the width", () => {
    expect(rule(pane, '[data-slot="pane-terminal"] .xterm')).toMatch(/padding:\s*0 var\(--ade-space-6\)/)
    // Not on the box, where the fit would count it as columns (and fit-rows.ts as rows).
    expect(rule(pane, '[data-slot="pane-terminal"]')).toMatch(/padding:\s*0;/)
  })

  test("is the 12 px of the approved mockup, from the spacing scale", () => {
    expect(read("index.css")).toMatch(/--ade-space-6:\s*12px/)
  })
})

describe("V2: the transcript does not scroll under the pill", () => {
  const pane = read("grid/pane.css")
  const selector =
    '[data-component="session-pane"]\n  > [data-slot="pane-header"]\n  ~ [data-slot="pane-transcript"]:not([data-slot="pane-dock"]):not([data-slot="pane-toast"])'

  test("its room for the pill is a border of the terminal's ground, so the scroll area starts below it", () => {
    const body = rule(pane, selector)
    expect(body).toMatch(/border-top:\s*42px solid var\(--ade-terminal-bg, var\(--ade-sunken\)\)/)
    expect(body).toMatch(/padding-top:\s*var\(--ade-space-2\)/)
  })

  test("and it beats the general 42 px of padding that every body after the header gets", () => {
    // (0,5,0) against the general rule's (0,4,0): the transcript is one more `[data-slot]` and the same two `:not()`.
    expect(pane).toContain('~ *:not([data-slot="pane-dock"]):not([data-slot="pane-toast"]) {\n  padding-top: 42px;')
  })
})

describe("V3: the focus ring", () => {
  const index = read("index.css")

  test("is one 2 px line of the weak text colour, not a line and a 4 px halo", () => {
    expect(index).toMatch(/--ade-focus-ring:\s*0 0 0 2px var\(--ade-text-weak\);/)
    expect(code(index)).not.toMatch(/--ade-focus-ring:[^;]*color-mix/)
  })

  test("a dialog's frame, which holds the focus without being a control, has none", () => {
    expect(rule(read("index.css"), '[data-layout="frame"]:focus-visible')).toMatch(/box-shadow:\s*none/)
  })
})

describe("V5: the disabled primary", () => {
  const remote = read("remote/remote.css")
  const body = rule(remote, '[data-component="remote-space"] [data-slot="primary"]:disabled')

  test("is the sunken ground with the weak text, not the accent at half opacity", () => {
    expect(body).toMatch(/background:\s*var\(--ade-sunken\)/)
    expect(body).toMatch(/color:\s*var\(--ade-text-weak\)/)
    expect(body).not.toContain("opacity")
  })

  test("and that text is 4.5:1 on that ground in both themes", () => {
    const index = read("index.css")
    const pair = (token: string) => {
      const match = new RegExp(`${token}:\\s*light-dark\\((#[0-9a-fA-F]{6}),\\s*(#[0-9a-fA-F]{6})\\)`).exec(index)
      if (!match) throw new Error(`${token} is not a light-dark() pair`)
      return { light: match[1]!, dark: match[2]! }
    }
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255) as [number, number, number]
      const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
      return (hi + 0.05) / (lo + 0.05)
    }
    for (const scheme of ["light", "dark"] as const) {
      const weak = pair("--ade-text-weak")[scheme]
      const sunken = pair("--ade-sunken")[scheme]
      expect([scheme, ratio(weak, sunken) >= 4.5]).toEqual([scheme, true])
    }
  })
})

describe("V7: the screenshot viewer's words", () => {
  const tray = read("shots/tray.css")

  test("are in the sans font and may wrap; only the file's name is monospace", () => {
    const caption = rule(tray, '[data-slot="shot-viewer-caption"]')
    expect(caption).toMatch(/font-family:\s*var\(--ade-sans\)/)
    expect(caption).toMatch(/flex-wrap:\s*wrap/)
    expect(rule(tray, '[data-slot="shot-viewer-name"]')).toMatch(/font-family:\s*var\(--ade-mono\)/)
  })
})

describe("V8: Impara's review button", () => {
  test("leaves room above the first lesson", () => {
    expect(rule(read("raguverse/learn/page/learn.css"), ".principale + .lesson")).toMatch(/margin-top:\s*0\.75rem/)
  })
})

describe("V9: the shortcuts' group notes", () => {
  test("are a paragraph of their own, not run on after the group's title", () => {
    const sections = read("settings/sections.tsx").replace(/\s+/g, " ")
    expect(sections).toContain('<p data-slot="section-desc"> <strong>{t(group.titleKey)}</strong> </p>')
    expect(sections).toContain('<Show when={group.noteKey}>{(note) => <p data-slot="section-desc">{t(note())}</p>}</Show>')
  })
})
