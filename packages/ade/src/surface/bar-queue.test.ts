import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { localePreference, setLocalePreference } from "../i18n"
import { NARROW_BAR, queueShown, queueText, queueTitle } from "./bar-queue"
import { codeOf } from "../test-support/source-text"

/*
 * DS-polish, piece 1: the bar. The queue buttons speak one grammar, their
 * accessible name is the text you read, and the bar is a grid in which
 * nothing is laid over anything. The layout itself is measured in ADE Test
 * (ade-team/prove/polish-barra/dopo); here the rules that make it so.
 */
const read = (...path: string[]) => readFileSync(join(import.meta.dir, "..", ...path), "utf8")

describe("the queue buttons' words", () => {
  test("the name for a screen reader is the text on the button, in its order", () => {
    const before = localePreference()
    setLocalePreference("it")
    const text = queueText("decisions", { waiting: 1, queued: 0, discarded: 14 })
    expect(text.label).toBe("Decisioni, 1 per te, 14 scartate")
    // Every visible piece is in the name, in the order it is read.
    let at = -1
    for (const piece of [text.name, text.pill, text.discarded!]) {
      const found = text.label.indexOf(piece, at + 1)
      expect([piece, found > at]).toEqual([piece, true])
      at = found
    }
    const design = queueText("design", { waiting: 3, queued: 2, discarded: 1 })
    expect(design.label).toBe("Design, 3 per te, 2 in coda, 1 scartata")
    expect([design.name, design.pill, design.queued, design.discarded]).toEqual([
      "Design",
      "3",
      "2 in coda",
      "1 scartata",
    ])
    setLocalePreference("en")
    expect(queueText("decisions", { waiting: 2, queued: 0, discarded: 0 }).label).toBe("Decisions, 2 for you")
    setLocalePreference(before)
  })

  test("shown when anything waits, is queued or was discarded; hidden at zero", () => {
    expect(queueShown({ waiting: 0, queued: 0, discarded: 0 })).toBe(false)
    expect(queueShown({ waiting: 0, queued: 0, discarded: 3 })).toBe(true)
    expect(queueShown({ waiting: 0, queued: 1, discarded: 0 })).toBe(true)
  })

  test("one component, with the open state and no title in place of the name", () => {
    const button = read("surface", "bar-queue-button.tsx")
    expect(button).toContain("aria-label={text().label}")
    expect(button).toContain("aria-expanded={props.open}")
    // The only title is the narrow one: with the name on the button it would repeat it.
    expect(button.match(/title=/g)).toEqual(["title="])
    expect(button).toContain("title={queueTitle(text(), narrow())}")
    expect(button).toContain("matchMedia(NARROW_BAR)")
    const workbench = read("surface", "workbench.tsx")
    // notifiche-design: one button for decisions and design, «Da scegliere», not one each.
    expect(workbench.match(/<BarQueueButton/g)).toEqual(["<BarQueueButton"])
    expect(workbench).toContain('family="choices"')
    expect(workbench).not.toContain('family="decisions"')
    expect(workbench).not.toContain('family="design"')
    expect(workbench).toContain("counts={choicesCounts()}")
    expect(workbench).toContain("onOpen={() => setChoicesOpen(true)}")
    expect(workbench).not.toContain('data-slot="decisions-badge"')
    expect(workbench).not.toContain('data-slot="design-badge"')
  })
})

describe("the narrow bar", () => {
  test("a tooltip equal to the accessible name, and none when the name is on the button", () => {
    const text = queueText("decisions", { waiting: 1, queued: 0, discarded: 14 })
    expect(queueTitle(text, true)).toBe(text.label)
    expect(queueTitle(text, false)).toBeUndefined()
  })

  test("the discarded get no dot: only what is queued keeps a mark", () => {
    const css = read("dev.css")
    const narrow = css.slice(css.indexOf(`@media ${NARROW_BAR}`))
    expect(narrow.length).toBeLessThan(css.length)
    const block = narrow.slice(0, narrow.indexOf("\n}\n"))
    expect(block).not.toContain("[data-discarded]")
    expect(block).toContain('[data-slot="bar-queue"][data-queued]::before')
  })
})

describe("the bar's layout", () => {
  const css = read("dev.css")
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`)
    return css.slice(at, css.indexOf("}", at))
  }

  test("a grid whose left side gives way first; the middle is in the flow", () => {
    expect(rule('[data-slot="ade-bar"]')).toContain(
      "grid-template-columns: minmax(0, max-content) minmax(max-content, 1fr) max-content",
    )
    expect(rule('[data-slot="ade-bar-center"]')).not.toContain("position: absolute")
    expect(css).not.toContain("--ade-bar-offset")
  })

  test("«Nuovo pannello» keeps its place in every view, unseen where it does nothing", () => {
    expect(rule('[data-slot="ade-menu-anchor"][data-idle]')).toContain("visibility: hidden")
    const workbench = read("surface", "workbench.tsx")
    expect(codeOf(workbench)).toContain(
      codeOf('data-idle={showsNewPane(wb().view) ? undefined : "true"} inert={!showsNewPane(wb().view)}'),
    )
    expect(codeOf(workbench)).not.toContain(codeOf("<Show when={showsNewPane(wb().view)}>"))
  })

  test("the left side has two weights and no capitals spaced out", () => {
    expect(rule('[data-slot="ade-project-name"]')).toContain("font-weight: var(--ade-weight-semibold)")
    expect(rule('[data-slot="ade-project-meta"]')).toContain("font-size: var(--ade-font-sm)")
    expect(rule('[data-slot="ade-project-meta"]')).toContain("color: var(--ade-text-soft)")
    expect(css).not.toContain('[data-slot="ade-count"]')
    expect(css).not.toContain('[data-slot="ade-project-warning"]')
  })
})

/*
 * The contrasts the bar is drawn with, computed from the tokens in index.css
 * (the light and dark halves of each `light-dark()`): AA, 4.5:1, for the text.
 */
describe("the bar's contrasts", () => {
  const index = read("index.css")
  // The first `light-dark()` of a token is its definition in `:root`; the glass theme writes plain colours.
  const root = index
  const token = (name: string): [string, string] => {
    const match = root.match(new RegExp(`--ade-${name}:\\s*light-dark\\((#[0-9a-fA-F]{6}),\\s*(#[0-9a-fA-F]{6})\\)`))
    if (!match) throw new Error(`--ade-${name} non è un light-dark di due colori`)
    return [match[1]!, match[2]!]
  }
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const ratio = (a: string, b: string) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
    return (x! + 0.05) / (y! + 0.05)
  }

  test("text, tabs, facts and pills are all at least 4.5:1, in light and in dark", () => {
    const pairs: [string, string, string][] = [
      ["tabs: soft on sunken", "text-soft", "sunken"],
      ["facts and asides: soft on the bar", "text-soft", "raised"],
      ["queue name: text on the bar", "text", "raised"],
      ["decisions pill", "accent-fg", "working"],
      ["design pill", "accent-fg", "accent-strong"],
    ]
    for (const [what, ink, ground] of pairs) {
      const [inkLight, inkDark] = token(ink)
      const [groundLight, groundDark] = token(ground)
      expect([what, "chiaro", ratio(inkLight, groundLight) >= 4.5]).toEqual([what, "chiaro", true])
      expect([what, "scuro", ratio(inkDark, groundDark) >= 4.5]).toEqual([what, "scuro", true])
    }
  })
})
