import { describe, expect, it } from "bun:test"
import { createSizeSettler, ptySize, ptySizeOf } from "./registry"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/*
 * S77: a restored pane's process was born at 120x30 and the fit that came
 * while it was being spawned was lost. `ptySize` is what the workbench passes
 * to the spawn and resizes to once the session is registered.
 */
describe("ptySize", () => {
  it("says nothing for a pane that has no terminal", () => {
    expect(ptySize("s77-never-made")).toBeUndefined()
  })

  it("says nothing for a terminal never drawn in a cell", () => {
    expect(ptySizeOf({})).toBeUndefined()
    expect(ptySizeOf({ settled: { cols: 80, rows: 23 } })).toBeUndefined()
  })

  it("says nothing for a drawn terminal whose size has not settled yet", () => {
    expect(ptySizeOf({ element: {} as HTMLElement })).toBeUndefined()
  })

  it("gives the settled columns and rows of a drawn terminal", () => {
    expect(ptySizeOf({ element: {} as HTMLElement, settled: { cols: 80, rows: 23 } })).toEqual({ cols: 80, rows: 23 })
  })

  it("never gives a size under two columns or one row", () => {
    expect(ptySizeOf({ element: {} as HTMLElement, settled: { cols: 1, rows: 23 } })).toBeUndefined()
    expect(ptySizeOf({ element: {} as HTMLElement, settled: { cols: 80, rows: 0 } })).toBeUndefined()
  })
})

/*
 * The one-column case (seen by the Architect during D73): a Claude pane resumed
 * after a reload printed its history one word per line. The process must hear
 * the size the cell ends at, not one it passed through while the grid laid out.
 */
describe("createSizeSettler", () => {
  it("sends only the size the cell ends at, not the ones it passed through", async () => {
    const sent: string[] = []
    const settler = createSizeSettler((cols, rows) => sent.push(`${cols}x${rows}`), 20)
    settler.push(5, 23)
    settler.push(40, 23)
    settler.push(80, 23)
    expect(sent).toEqual([])
    await wait(40)
    expect(sent).toEqual(["80x23"])
  })

  it("sends a new size once it holds, and the same size only once", async () => {
    const sent: string[] = []
    const settler = createSizeSettler((cols, rows) => sent.push(`${cols}x${rows}`), 10)
    settler.push(80, 23)
    await wait(25)
    settler.push(80, 23)
    await wait(25)
    settler.push(120, 30)
    await wait(25)
    expect(sent).toEqual(["80x23", "120x30"])
  })

  it("sends nothing once cancelled, as when the pane is detached", async () => {
    const sent: string[] = []
    const settler = createSizeSettler((cols, rows) => sent.push(`${cols}x${rows}`), 10)
    settler.push(80, 23)
    settler.cancel()
    await wait(25)
    expect(sent).toEqual([])
  })
})
