import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * Live test 5, FAIL 1: in a grid of 5 or 6 panes at 1440x900 a pane is 76x13, and the note and «Consegna ora» took it to
 * 76x6 (ragu 76x4). The box no longer fitted, the reading said `none`, and the note kept the mail it was explaining held.
 * Read from the source, as happy-dom does not lay out or cascade container queries. The live proof is the tester's.
 */
const css = readFileSync(join(import.meta.dir, "pane.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")

/** The height of a pane of that grid: 13 rows, the room for the header, and the pane's border. */
const PANE_AT_THE_TEST = 13 * 18 + 42

const short = css.match(/@container \(max-height: (\d+)px\) \{([\s\S]*?)\n\}/)

describe("a short pane keeps its rows", () => {
  test("the pane is a container for its height, or the query never applies", () => {
    expect(css).toMatch(/\[data-component="session-pane"\] \{[^}]*container-type: size/)
  })

  test("the rule reaches the size of the failing grid, and leaves the two-row grid alone", () => {
    expect(short).not.toBeNull()
    expect(Number(short![1])).toBeGreaterThanOrEqual(PANE_AT_THE_TEST)
    expect(Number(short![1])).toBeLessThan(400)
  })

  test("the note is out of the flow: it takes no row from the terminal", () => {
    expect(short![2]).toMatch(/\[data-slot="pane-notice"\] \{[^}]*position: absolute/)
  })

  test("so is «Consegna ora», and only over a terminal: a pane with none types in the dock, and Riprova or Riprendi keep their row", () => {
    expect(short![2]).toMatch(/\[data-slot="pane-terminal"\] ~ \[data-slot="pane-dock"\]\[data-offer\] \{[^}]*position: absolute/)
    expect(short![2]).not.toMatch(/\[data-slot="pane-terminal"\] ~ \[data-slot="pane-dock"\] \{/)
    expect(short![2]).not.toMatch(/^\s*\[data-slot="pane-dock"\]/m)
  })
})
