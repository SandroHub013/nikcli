import { describe, expect, test } from "bun:test"
import { BROWSE_SANDBOX, DESIGN_SANDBOX, frameSandbox, INITIAL_DESIGN_WATCH, watchDesign, type DesignWatchEvent } from "./design-mode"
import { fitViewport } from "./viewport"

/* D1: the frame of a design page, and how the pane knows it is still there. */

const target = { k: "DS-A", variant: 1, path: "C:/p/.ade/design/DS-A/1.html", roots: ["C:/p"] }

describe("the frame's sandbox", () => {
  test("in Design mode, no origin of its own and nothing that leaves the frame", () => {
    const tokens = frameSandbox(target).split(/\s+/)
    expect(tokens).toContain("allow-scripts")
    expect(tokens).not.toContain("allow-same-origin")
    expect(tokens).not.toContain("allow-popups")
    expect(tokens).not.toContain("allow-top-navigation")
    expect(frameSandbox(target)).toBe(DESIGN_SANDBOX)
  })

  test("an ordinary page keeps the frame it had", () => {
    expect(frameSandbox(undefined)).toBe(BROWSE_SANDBOX)
    expect(BROWSE_SANDBOX).toContain("allow-same-origin")
  })
})

describe("watchDesign", () => {
  const run = (...events: DesignWatchEvent[]) => events.reduce(watchDesign, INITIAL_DESIGN_WATCH)

  test("the first load is the variant", () => {
    expect(run({ type: "load" }).left).toBe(false)
  })

  test("a load the pane did not cause is the frame going elsewhere", () => {
    expect(run({ type: "load" }, { type: "load" }).left).toBe(true)
  })

  test("it stays gone until the pane loads the variant again", () => {
    expect(run({ type: "load" }, { type: "load" }, { type: "load" }).left).toBe(true)
    expect(run({ type: "load" }, { type: "load" }, { type: "src" }, { type: "load" }).left).toBe(false)
  })

  test("a reload by the pane is not leaving", () => {
    expect(run({ type: "load" }, { type: "src" }, { type: "load" }).left).toBe(false)
  })
})

describe("the size a design page declares", () => {
  test("is the viewport, scaled to fit and never up", () => {
    const fit = fitViewport({ preset: "responsive", containerWidth: 600, containerHeight: 900, size: { width: 1200, height: 800 } })
    expect(fit.isResponsive).toBe(false)
    expect(fit.viewportWidth).toBe(1200)
    expect(fit.viewportHeight).toBe(800)
    expect(fit.scale).toBe(0.5)
  })

  test("a small page is not blown up", () => {
    const fit = fitViewport({ preset: "responsive", containerWidth: 2000, containerHeight: 2000, size: { width: 360, height: 240 } })
    expect(fit.scale).toBe(1)
  })

  test("without one, the pane's width, as before", () => {
    expect(fitViewport({ preset: "responsive", containerWidth: 600, containerHeight: 900 }).isResponsive).toBe(true)
  })

  test("fitWidth scales to width, allowing tall reading pages to scroll instead of shrinking to fit height", () => {
    const withoutFitWidth = fitViewport({
      preset: "responsive",
      containerWidth: 800,
      containerHeight: 600,
      size: { width: 760, height: 1600 },
    })
    // Without fitWidth: scale is 600 / 1600 = 0.375
    expect(withoutFitWidth.scale).toBe(600 / 1600)

    const withFitWidth = fitViewport({
      preset: "responsive",
      containerWidth: 800,
      containerHeight: 600,
      size: { width: 760, height: 1600 },
      fitWidth: true,
    })
    // With fitWidth: scale is min(1, 800 / 760) = 1 (fits width)
    expect(withFitWidth.scale).toBe(1)
    expect(withFitWidth.renderedWidth).toBe(760)
    expect(withFitWidth.renderedHeight).toBe(1600)

    const narrowContainer = fitViewport({
      preset: "responsive",
      containerWidth: 380,
      containerHeight: 600,
      size: { width: 760, height: 1600 },
      fitWidth: true,
    })
    // When container is narrower than 760 (e.g. 380), scale is 380 / 760 = 0.5
    expect(narrowContainer.scale).toBe(0.5)
    expect(narrowContainer.renderedWidth).toBe(380)
    expect(narrowContainer.renderedHeight).toBe(800)
  })
})

describe("the arrows between variants (D2)", () => {
  test("previous and next inside the proposal, nothing past either end", async () => {
    const { stepVariant } = await import("./design-mode")
    expect(stepVariant(2, -1, 3)).toBe(1)
    expect(stepVariant(2, 1, 3)).toBe(3)
    expect(stepVariant(1, -1, 3)).toBeUndefined()
    expect(stepVariant(3, 1, 3)).toBeUndefined()
  })
})

/*
 * The Architect's BASSO 1 on D1: a new document asks for the bridge before
 * its `load`. On a slow page outside the proposal, a real click in that
 * window was taken as a selection. A second ask is leaving too.
 */
describe("watchDesign counts a second handshake as leaving", () => {
  const run = (...events: DesignWatchEvent[]) => events.reduce(watchDesign, INITIAL_DESIGN_WATCH)

  test("the variant's own ask is not leaving", () => {
    expect(run({ type: "ask" }, { type: "load" }).left).toBe(false)
  })

  test("a second ask, before any load, is", () => {
    expect(run({ type: "ask" }, { type: "load" }, { type: "ask" }).left).toBe(true)
    expect(run({ type: "ask" }, { type: "ask" }).left).toBe(true)
  })

  test("the pane's reload asks again without leaving", () => {
    expect(run({ type: "ask" }, { type: "load" }, { type: "src" }, { type: "ask" }, { type: "load" }).left).toBe(false)
  })
})

/*
 * D2 review, BASSO 1: the browser's back and forward were still drawn in
 * Design mode. `hidden` lost to the slot's own `display: grid`.
 */
describe("the hidden nav buttons", () => {
  test("a hidden nav button is not displayed", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const css = readFileSync(join(import.meta.dir, "browser.css"), "utf8").replace(/\s+/g, " ")
    expect(css).toMatch(/\[data-slot="browser-nav-btn"\]\[hidden\] \{ display: none;? \}/)
  })
})
