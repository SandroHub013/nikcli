import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { rowsInside, terminalBox, type TerminalBox } from "./fit-rows"

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
