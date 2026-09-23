import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * "Alt+click to the program" never wraps and does not shrink, so in a narrow
 * pane it would push the header's buttons out (audit 0.7.7, MEDIO 18). It is
 * hidden by the header's own collapse order: the hint is a `.tok`, and
 * `.hA .tok` goes at 720px, well before the 420px rule for cost and tokens.
 * Read from the sources, as happy-dom does not cascade container queries.
 */
const dir = import.meta.dir
const pane = readFileSync(join(dir, "pane.tsx"), "utf8")
const css = readFileSync(join(dir, "pane.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")

/** The selectors hidden by each `@container (max-width: Npx)` block. */
function hiddenAt(): { width: number; selectors: string[] }[] {
  const blocks: { width: number; selectors: string[] }[] = []
  for (const block of css.matchAll(/@container \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g)) {
    const selectors = [...block[2].matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((rule) => /display:\s*none/.test(rule[2]))
      .flatMap((rule) => rule[1].split(",").map((selector) => selector.trim()))
    blocks.push({ width: Number(block[1]), selectors })
  }
  return blocks
}

describe("the mouse hint leaves a narrow pane's header", () => {
  test("it sits in the pill header, as a token", () => {
    const hint = pane.match(/<span class="([^"]*)" data-slot="pane-mouse-hint"/)
    expect(hint?.[1].split(" ")).toContain("tok")
    const header = pane.indexOf('class="pill hA" data-slot="pane-header"')
    expect(header).toBeGreaterThan(-1)
    expect(pane.indexOf('data-slot="pane-mouse-hint"')).toBeGreaterThan(header)
  })

  test("a container query hides it at 420px or wider, with cost and tokens", () => {
    const widest = hiddenAt()
      .filter((block) => block.selectors.some((selector) => selector === ".hA .tok" || selector === '[data-slot="pane-mouse-hint"]'))
      .map((block) => block.width)
    expect(Math.max(0, ...widest)).toBeGreaterThanOrEqual(420)
  })
})
