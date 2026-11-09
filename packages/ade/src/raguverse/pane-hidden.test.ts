import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * MOD-5 (piano-aperti, batch 2): a world that is paused (its panel hidden, or a lesson over it) must stay paused.
 *  - a `hello` that arrives while paused made a new link that ran: the world kept rendering behind a hidden panel;
 *  - a `slow` that arrives while hidden reloaded the frame, which started a new world nobody could see.
 * The pane mounts a frame and a port, which happy-dom cannot offer, so the two rules are read from the source.
 */
const source = readFileSync(join(import.meta.dir, "raguverse-pane.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")

/** The text from `start` up to the next line that is indented by the same amount as `start`'s own line. */
function block(start: string): string {
  const at = source.indexOf(start)
  expect(at).toBeGreaterThan(-1)
  const lineStart = source.lastIndexOf("\n", at) + 1
  const indent = /^\s*/.exec(source.slice(lineStart))![0]
  const rest = source.slice(at)
  const end = rest.search(new RegExp(`\\n${indent}[}\\])]`))
  return rest.slice(0, end === -1 ? undefined : end)
}

describe("a paused world stays paused (MOD-5)", () => {
  test("a link made while the world is not running is paused at once", () => {
    const connect = block("const connect = (target: Window) => {")
    const afterLink = connect.slice(connect.indexOf("link = current"))
    expect(afterLink).toMatch(/if \(lifecycle\.phase\(\) !== "running"\) current\.pause\(\)/)
  })

  test("`slow` while hidden does not reload the frame: it waits to be seen", () => {
    const slow = block("slow: () => {")
    expect(slow).toContain("lowering.lower()")
    expect(slow).toContain("setLowered(")
    expect(slow).toMatch(/if \(lifecycle\.phase\(\) === "running"\) reloadFrame\(\)\s*else reloadWhenSeen = true/)
  })

  test("when the panel is seen again, a reload that was owed happens, otherwise the link resumes", () => {
    const create = block("const lifecycle = createLifecycle({")
    const resume = block("resume: () => {")
    expect(create).toContain("resume: () => {")
    expect(resume).toMatch(/if \(reloadWhenSeen\) \{\s*reloadWhenSeen = false\s*reloadFrame\(\)\s*return\s*\}/)
    expect(resume).toContain("link?.resume()")
  })

  test("a load is a new frame: it owes nothing", () => {
    // With its newline: `unload: () => {` holds the same letters.
    const load = block("\n    load: () => {")
    expect(load).toContain("reloadWhenSeen = false")
  })

  test("the flag exists, and starts false", () => {
    expect(source).toMatch(/let reloadWhenSeen = false/)
  })
})
