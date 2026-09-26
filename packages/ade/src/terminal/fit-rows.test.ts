import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { rowsInside, terminalBox, watchCellSize, type ScaleWindow, type TerminalBox } from "./fit-rows"

/*
 * ade/pannello-righe: measured live in ADE Test, a Claude Code pane at 1800 px.
 * The terminal's box was 836 px tall, border-box, with 42 px of top padding
 * for the header pill, and cells 17.59 px tall. FitAddon proposed 47 rows,
 * floor(836 / 17.59); the last row ended at 923 px, under a box ending at 890.
 */
const PANE: TerminalBox = { height: 836, borderBox: true, paddingTop: 42, paddingBottom: 0, borderTop: 0, borderBottom: 0 }
const CELL = 17.59

describe("the rows a terminal box holds", () => {
  test("the box's padding is not rows: 45 fit where FitAddon proposed 47", () => {
    expect(Math.floor(PANE.height / CELL)).toBe(47)
    const rows = rowsInside(PANE, CELL)
    expect(rows).toBe(45)
    // The last row ends inside the content: 42 + 45 × 17.59 = 833.55 ≤ 836.
    expect(PANE.paddingTop + rows * CELL).toBeLessThanOrEqual(PANE.height)
  })

  test("borders, bottom padding and a content-box box are counted as they are", () => {
    expect(rowsInside({ ...PANE, paddingTop: 0 }, CELL)).toBe(47)
    expect(rowsInside({ ...PANE, paddingBottom: 18, borderTop: 1, borderBottom: 1 }, CELL)).toBe(44)
    // content-box: the computed height is the content already.
    expect(rowsInside({ ...PANE, borderBox: false }, CELL)).toBe(47)
  })

  test("a box too small for a row still has one", () => {
    expect(rowsInside({ ...PANE, height: 30 }, CELL)).toBe(1)
  })

  test("the box is read from its computed style", () => {
    const style = new Map([
      ["height", "836px"],
      ["box-sizing", "border-box"],
      ["padding-top", "42px"],
      ["padding-bottom", "0px"],
      ["border-top-width", "0px"],
      ["border-bottom-width", ""],
    ])
    expect(terminalBox({ getPropertyValue: (name: string) => style.get(name) ?? "" })).toEqual(PANE)
  })
})

describe("lint: the fit", () => {
  test("lint: every fit of a pane's terminal takes the fewer of FitAddon's rows and the rows inside its box, in one resize", () => {
    const registry = readFileSync(join(import.meta.dir, "registry.ts"), "utf8")
    const start = registry.indexOf("const applyFit = () => {")
    expect(start).toBeGreaterThan(-1)
    const body = registry.slice(start, registry.indexOf("\n  }\n", start))
    // FitAddon's own fit() resized once more before the cut: two resizes of the pty, two redraws.
    expect(body.includes("session.fit.fit()")).toBe(false)
    const proposed = body.indexOf("session.fit.proposeDimensions()")
    const cut = body.indexOf("Math.min(proposed.rows, rowsInside(terminalBox(getComputedStyle(element)), cell))")
    expect(proposed).toBeGreaterThan(-1)
    expect(cut).toBeGreaterThan(proposed)
    expect(body.split("session.terminal.resize(").length - 1).toBe(1)
    expect(body.indexOf("session.terminal.resize(proposed.cols, rows)")).toBeGreaterThan(cut)
  })
})

/*
 * Verifiche, pannello-righe-scatti, BASSO 1: the page emulated at 1400x900
 * with DPR 1 instead of 1.25. The cell went from 17.61 to 18 px, the box did
 * not change, the rows stayed 21, and the last one ran 7 px past the box.
 */
function fakeTerminal() {
  const listeners = new Set<() => void>()
  const terminal = {
    _core: {
      _renderService: {
        onDimensionsChange(listener: () => void) {
          listeners.add(listener)
          return { dispose: () => void listeners.delete(listener) }
        },
      },
    },
  }
  return { terminal, fire: () => listeners.forEach((listener) => listener()), listening: () => listeners.size }
}

describe("a new scale, the same box", () => {
  test("the rows are counted again when the cell changes, and the last one is back inside", () => {
    // 42 px of padding and 21 rows of 17.61 px fit a 413 px box; of 18 px they end at 420.
    const box: TerminalBox = { height: 413, borderBox: true, paddingTop: 42, paddingBottom: 0, borderTop: 0, borderBottom: 0 }
    let cell = 17.61
    let rows = rowsInside(box, cell)
    expect(rows).toBe(21)
    const { terminal, fire } = fakeTerminal()
    const stop = watchCellSize(terminal, () => (rows = rowsInside(box, cell)))
    // The screen's scale changes: the cell grows, the box does not, and the rows run 7 px past it.
    cell = 18
    expect(box.paddingTop + rows * cell - box.height).toBe(7)
    fire()
    expect(rows).toBe(20)
    expect(box.paddingTop + rows * cell).toBeLessThanOrEqual(box.height)
    stop()
  })

  test("the watch ends with the pane: no listener is left on the terminal", () => {
    const { terminal, listening } = fakeTerminal()
    const stop = watchCellSize(terminal, () => {})
    expect(listening()).toBe(1)
    stop()
    expect(listening()).toBe(0)
  })

  test("a change of the screen's scale, which xterm's event does not report, is watched and answered a frame later", () => {
    const queries: { query: string; listeners: Set<() => void> }[] = []
    const frames: (() => void)[] = []
    const win: ScaleWindow = {
      devicePixelRatio: 1.25,
      matchMedia(query) {
        const entry = { query, listeners: new Set<() => void>() }
        queries.push(entry)
        return {
          addEventListener: (_type, listener) => void entry.listeners.add(listener),
          removeEventListener: (_type, listener) => void entry.listeners.delete(listener),
        }
      },
      requestAnimationFrame(callback) {
        frames.push(callback)
        return frames.length
      },
    }
    let calls = 0
    const { terminal, listening } = fakeTerminal()
    const stop = watchCellSize(terminal, () => calls++, win)
    expect(queries.map((entry) => entry.query)).toEqual(["(resolution: 1.25dppx)"])
    ;(win as { devicePixelRatio: number }).devicePixelRatio = 1
    for (const listener of [...queries[0]!.listeners]) listener()
    // Asked again at the new scale, and the old query let go.
    expect(queries.map((entry) => entry.query)).toEqual(["(resolution: 1.25dppx)", "(resolution: 1dppx)"])
    expect(queries[0]!.listeners.size).toBe(0)
    expect(calls).toBe(0)
    frames.shift()!()
    expect(calls).toBe(1)
    stop()
    expect(queries[1]!.listeners.size).toBe(0)
    expect(listening()).toBe(0)
  })

  test("lint: attachTerminal fits again when the cell changes, and stops watching on detach", () => {
    const registry = readFileSync(join(import.meta.dir, "registry.ts"), "utf8")
    const start = registry.indexOf("export function attachTerminal(")
    expect(start).toBeGreaterThan(-1)
    const body = registry.slice(start)
    expect(body.includes("const stopCellWatch = watchCellSize(session.terminal, () => applyFit()")).toBe(true)
    const detach = body.indexOf("const detach = () => {")
    expect(detach).toBeGreaterThan(-1)
    expect(body.slice(detach, detach + 200).includes("stopCellWatch()")).toBe(true)
  })
})
