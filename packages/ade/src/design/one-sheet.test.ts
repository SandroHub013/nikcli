import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fitScale, frameProps, VARIANT_SANDBOX, VIEW_MARGIN, watchInView } from "./design-preview"

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

/*
 * notifiche-design review, BASSO 2: every variant ran at once on the sheet,
 * scripts, WebGL and animations. A frame now runs only while it is in view,
 * or near it, and out of view it is taken away with its scripts.
 */
describe("a variant runs only while it can be seen", () => {
  type Callback = (entries: { isIntersecting: boolean }[]) => void
  function fakeObserver() {
    const made: { callback: Callback; margin?: string; observed: Element[]; disconnected: boolean }[] = []
    class Fake {
      readonly record: (typeof made)[number]
      constructor(callback: Callback, options?: { rootMargin?: string }) {
        this.record = { callback, margin: options?.rootMargin, observed: [], disconnected: false }
        made.push(this.record)
      }
      observe(element: Element) {
        this.record.observed.push(element)
      }
      disconnect() {
        this.record.disconnected = true
      }
    }
    return { made, Observer: Fake as unknown as typeof IntersectionObserver }
  }

  test("watchInView says when the page comes into view and when it leaves, and stops", () => {
    const { made, Observer } = fakeObserver()
    const element = {} as Element
    const seen: boolean[] = []
    const stop = watchInView(element, (inView) => seen.push(inView), Observer)
    expect(made[0]!.observed).toEqual([element])
    expect(made[0]!.margin).toBe(VIEW_MARGIN)
    expect(seen).toEqual([])
    made[0]!.callback([{ isIntersecting: true }])
    made[0]!.callback([{ isIntersecting: true }, { isIntersecting: false }])
    expect(seen).toEqual([true, false])
    stop()
    expect(made[0]!.disconnected).toBe(true)
  })

  test("with no IntersectionObserver the page is in view, as before", () => {
    const seen: boolean[] = []
    watchInView({} as Element, (inView) => seen.push(inView), null)
    expect(seen).toEqual([true])
  })

  test("lint: DesignPreview draws the frame only while watchInView says it is in view", () => {
    const tsx = readFileSync(join(import.meta.dir, "design-preview.tsx"), "utf-8")
    expect(tsx).toContain("onCleanup(watchInView(containerRef, setInView))")
    const frame = tsx.indexOf('data-slot="preview-frame"')
    const gate = tsx.lastIndexOf("<Show when={inView()}", frame)
    expect(gate).toBeGreaterThan(-1)
    expect(tsx.slice(gate, frame)).not.toContain("</Show>")
  })
})

/*
 * notifiche-design review, BASSO 3 (TEAM.md, source tests): a test that reads
 * a source file proves no behaviour, and its name must say it is a lint.
 */
test("lint: the notifiche-design tests that read a source file are named lint:", () => {
  const files = [
    join(import.meta.dir, "one-sheet.test.ts"),
    join(import.meta.dir, "sheet-url.test.ts"),
    join(import.meta.dir, "..", "browser", "no-design-mode.test.ts"),
  ]
  const wrong: string[] = []
  for (const file of files) {
    const parts = readFileSync(file, "utf-8")
      .split(/\n\s*test\(/)
      .slice(1)
    for (const part of parts) {
      const name = /^["'`](.*?)["'`],/.exec(part)?.[1] ?? part.slice(0, 40)
      const reads = /\bread(?:FileSync)?\(|\bexistsSync\(/.test(part)
      if (reads && !name.startsWith("lint:")) wrong.push(`${file.split(/[\\/]/).pop()}: ${name}`)
    }
  }
  expect(wrong).toEqual([])
})
