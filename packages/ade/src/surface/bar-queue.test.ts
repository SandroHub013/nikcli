import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { localePreference, setLocalePreference } from "../i18n"
import { createOpenKeyTracker, newlyOpened, queueItemLabel } from "./bar-queue"
import { codeOf } from "../test-support/source-text"

/*
 * DS-polish, piece 1: the bar. The queue buttons speak one grammar, their
 * accessible name is the text you read, and the bar is a grid in which
 * nothing is laid over anything. The layout itself is measured in ADE Test
 * (ade-team/prove/polish-barra/dopo); here the rules that make it so.
 */
const read = (...path: string[]) => readFileSync(join(import.meta.dir, "..", ...path), "utf8")

describe("the queue buttons' words", () => {
  test("the queue buttons group uses PillTabs with role button, always rendered in the bar", () => {
    const workbench = read("surface", "workbench.tsx")
    expect(workbench).not.toContain("<BarQueueButton")
    expect(workbench).toContain('role="button"')
    expect(workbench).toContain("items={queueItems()}")
    expect(workbench).toContain("onSelect={onSelectQueue}")
    // The group is always rendered, never conditionally hidden behind queueShown
    expect(workbench).not.toContain("<Show when={queueShown(")
  })

  test("queueItemLabel builds accessible name and title without discarded counts", () => {
    const before = localePreference()
    setLocalePreference("it")
    expect(queueItemLabel("decisions", 0, 0)).toBe("Decisioni")
    expect(queueItemLabel("decisions", 2, 0)).toBe("Decisioni, 2 per te")
    expect(queueItemLabel("decisions", 1, 3)).toBe("Decisioni, 1 per te, 3 in coda")
    expect(queueItemLabel("design", 0, 2)).toBe("Design, 2 in coda")
    setLocalePreference("en")
    expect(queueItemLabel("decisions", 2, 0)).toBe("Decisions, 2 for you")
    expect(queueItemLabel("design", 1, 2)).toBe("Design, 1 for you, 2 queued")
    setLocalePreference(before)
  })

  test("discarded lines do not turn on any badge: badge only reflects waiting items", () => {
    const workbench = read("surface", "workbench.tsx")
    expect(workbench).toContain("badge: decWaiting > 0 ? decWaiting : undefined")
    expect(workbench).toContain("badge: desWaiting > 0 ? desWaiting : undefined")
  })

  test("clicking Decisioni or Design opens the respective sheet or pane", () => {
    const workbench = read("surface", "workbench.tsx")
    expect(workbench).toContain('if (id === "decisions") handleOpenDecisions()')
    expect(workbench).toContain('else if (id === "design") handleOpenDesign()')
    expect(workbench).toContain("setDecisionsOpen(true)")
    expect(workbench).toContain("openDecisionsPane()")
    expect(workbench).toContain("setDesignOpen(true)")
    expect(workbench).toContain("openDesignPane()")
  })
})

describe("tracking newly opened register keys (O2)", () => {
  test("newlyOpened returns only items with keys not yet in seen", () => {
    const seen = new Set<string>(["D1", "D2"])
    const items = [
      { k: "D1", title: "Prima" },
      { k: "D2", title: "Seconda" },
      { k: "D3", title: "Terza" },
    ]
    const fresh = newlyOpened(seen, items)
    expect(fresh).toEqual([{ k: "D3", title: "Terza" }])
    expect(seen.has("D3")).toBe(true)
  })

  test("createOpenKeyTracker establishes baseline on first load without reporting new items", () => {
    const tracker = createOpenKeyTracker<{ k: string; title: string }>()
    const initial = [
      { k: "D1", title: "Prima" },
      { k: "D2", title: "Seconda" },
      { k: "D3", title: "Terza" },
    ]
    // Initial load: 3 open items, returns empty (no false alerts on startup)
    const fresh = tracker.update("/progetto-1", initial)
    expect(fresh).toEqual([])
    expect(tracker.seen.size).toBe(3)

    // +1 key added: reports the new item
    const withNew = [...initial, { k: "D4", title: "Quarta" }]
    const added = tracker.update("/progetto-1", withNew)
    expect(added).toEqual([{ k: "D4", title: "Quarta" }])
    expect(tracker.seen.size).toBe(4)

    // Same items again: nothing new
    expect(tracker.update("/progetto-1", withNew)).toEqual([])
  })

  test("createOpenKeyTracker resets baseline on register path change without reporting new items (D1)", () => {
    const tracker = createOpenKeyTracker<{ k: string; title: string }>()
    // Project A loaded: establishes baseline for A
    const initialA = tracker.update("/progetto-A/.ade/decisions.jsonl", [{ k: "D1", title: "Prima" }])
    expect(initialA).toEqual([])

    // While project switches to B, old register A is still loaded: same path, no new items
    const switchInFlight = tracker.update("/progetto-A/.ade/decisions.jsonl", [{ k: "D1", title: "Prima" }])
    expect(switchInFlight).toEqual([])

    // Now register B finishes loading and updates: path changes, baseline established for B: zero toasts
    const initialB = tracker.update("/progetto-B/.ade/decisions.jsonl", [
      { k: "X1", title: "Altro progetto 1" },
      { k: "X2", title: "Altro progetto 2" },
    ])
    expect(initialB).toEqual([])
    expect(tracker.seen.has("X1")).toBe(true)
    expect(tracker.seen.has("X2")).toBe(true)
    expect(tracker.seen.has("D1")).toBe(false)

    // Later, a new item arrives in project B: alerts only for that item
    const addedB = tracker.update("/progetto-B/.ade/decisions.jsonl", [
      { k: "X1", title: "Altro progetto 1" },
      { k: "X2", title: "Altro progetto 2" },
      { k: "X3", title: "Nuova voce B" },
    ])
    expect(addedB).toEqual([{ k: "X3", title: "Nuova voce B" }])
  })

  test("createOpenKeyTracker reports newly opened items when one closes and another opens with equal count", () => {
    const tracker = createOpenKeyTracker<{ k: string; title: string }>()
    tracker.update("/progetto-1", [
      { k: "D1", title: "Prima" },
      { k: "D2", title: "Seconda" },
    ])

    // D1 is closed, but D3 is newly opened. Count remains 2.
    const updated = tracker.update("/progetto-1", [
      { k: "D2", title: "Seconda" },
      { k: "D3", title: "Terza" },
    ])
    expect(updated).toEqual([{ k: "D3", title: "Terza" }])
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
