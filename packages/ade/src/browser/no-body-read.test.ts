import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * MOD-12: `settleWithoutBridge` fetched the page only to look at its headers and its status, and then read the whole
 * body into a string it never used. For a page that is large, or never ends (a stream, an event source), that held
 * the memory and the connection open. The body is not read: it is cancelled. Read from the source: the pane needs a
 * frame and a host.
 */
const source = readFileSync(join(import.meta.dir, "browser-pane.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")

function functionText(name: string): string {
  const at = source.indexOf(`const ${name} = async`)
  expect(at).toBeGreaterThan(-1)
  const rest = source.slice(at)
  const end = rest.search(/\n {2}\}\n/)
  return rest.slice(0, end === -1 ? undefined : end)
}

describe("the framing check does not read the page's body (MOD-12)", () => {
  const text = functionText("settleWithoutBridge")

  test("no res.text() in the function", () => {
    expect(text).not.toContain("res.text(")
  })

  test("the body is cancelled instead", () => {
    expect(text).toContain("body?.cancel(")
  })
})
