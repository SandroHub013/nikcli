import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fitScale, frameProps, VARIANT_SANDBOX } from "./design-preview"

/*
 * notifiche-design, the one sheet of a proposal. Apart from ui.test.ts, which
 * loads the Kobalte sheet: these read only plain modules and sources.
 */
describe("the one sheet of a proposal", () => {
  test("lint: the page is a live frame loaded by src — no srcdoc, no allow-same-origin, fitted to its column", () => {
    const tsx = readFileSync(join(import.meta.dir, "design-preview.tsx"), "utf-8")
    const code = tsx
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\/.*$/gm, "")
    expect(code).not.toContain("srcdoc")
    expect(code).toContain("{...frameProps(current, measured(), title())}")
    expect(code).toContain("transform: `scale(${fit().scale})`")
    // Live: the page can be tried where it is, not in another pane.
    expect(code).not.toContain("pointer-events")
    expect(code).not.toContain("allow-same-origin")
  })

  /*
   * notifiche-design: the variants were miniatures, scaled to a 330×220 box
   * and cut, to be opened one by one in the browser pane. On the one sheet a
   * page is at its own size, smaller only when its column is, and never cut.
   */
  test("fitScale: the page's own size, smaller only when the column is, never cut", () => {
    expect(fitScale({ width: 760, height: 1600 }, 1200)).toEqual({
      scale: 1,
      width: 760,
      height: 1600,
      frameWidth: 760,
      frameHeight: 1600,
    })
    const narrow = fitScale({ width: 760, height: 1600 }, 380)
    expect(narrow.scale).toBe(0.5)
    expect([narrow.width, narrow.height]).toEqual([380, 800])
    expect(fitScale({ width: 760, height: 1600 }, 0).scale).toBe(1)
  })

  test("lint: DesignPreview re-measures with a ResizeObserver and fits the page to the measured width", () => {
    const tsx = readFileSync(join(import.meta.dir, "design-preview.tsx"), "utf-8")
    expect(tsx).toContain("ResizeObserver")
    expect(tsx).toContain("fitScale(measured(), measuredWidth())")
  })

  test("frameProps lets the page run, at an opaque origin", () => {
    const props = frameProps({ src: "http://example.com" }, { width: 360, height: 240 }, "Title")
    expect(props.sandbox).toBe(VARIANT_SANDBOX)
    expect(VARIANT_SANDBOX).toBe("allow-scripts allow-forms")
  })

  test("lint: each variant has «Scegli questa», and no «Apri grande» sends it to another pane", () => {
    const card = readFileSync(join(import.meta.dir, "design-card.tsx"), "utf-8")
    expect(card).toContain('data-slot="variant-choose"')
    expect(card).toContain("onClick={() => (props.onChoose ?? props.onPick)(index())}")
    expect(card).not.toContain("variant-open-large")
    const sheet = readFileSync(join(import.meta.dir, "design-sheet.tsx"), "utf-8")
    expect(sheet).toContain("if (!proposal().multi) void submit()")
    expect(sheet).toContain('size="xl"')
  })
})
