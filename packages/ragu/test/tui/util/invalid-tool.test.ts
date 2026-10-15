import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { invalidToolRow } from "@tui/util/invalid-tool"

/*
 * Review of the UI, N6: a call to a tool the model was not given showed as «⚙ invalid [tool=list, error=Model tried
 * to call unavailable tool 'list'.]». It says the tool the model asked for, in words.
 */
describe("a call that landed on the invalid tool", () => {
  test("an unavailable tool is named, and said not to be available", () => {
    expect(invalidToolRow({ tool: "list", error: "Model tried to call unavailable tool 'list'." })).toBe(
      "list is not available to this model",
    )
  })

  test("arguments that do not fit say so, with the first line of why", () => {
    expect(invalidToolRow({ tool: "read", error: "filePath: expected string\nreceived undefined" })).toBe(
      "read was called with invalid arguments: filePath: expected string",
    )
  })

  test("a long reason is cut with an ellipsis, not three dots", () => {
    const row = invalidToolRow({ tool: "read", error: "x".repeat(300) })
    expect(row.endsWith("…")).toBe(true)
    expect(row).not.toContain("...")
    expect(row.length).toBeLessThan(200)
  })

  test("a call with nothing to name still reads as a sentence", () => {
    expect(invalidToolRow({})).toBe("a tool is not available to this model")
    expect(invalidToolRow(undefined)).toBe("a tool is not available to this model")
  })

  test("the session view draws it, in the error colour, not through the generic view", () => {
    const source = readFileSync(join(import.meta.dir, "../../../../tui/src/routes/session/tool-view.tsx"), "utf8")
    expect(source).toContain('toolName() === "invalid"')
    expect(source).toContain("invalidToolRow(")
    expect(source).toMatch(/<InvalidTool[\s\S]*?function InvalidTool[\s\S]*?theme\.status\.error\.fg/)
  })
})
