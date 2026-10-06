import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("the key form (full review 2026-10-06, bots)", () => {
  test("trims what was pasted before judging and saving it", () => {
    const source = readFileSync(join(__dirname, "keys-section.tsx"), "utf-8")
    expect(source).toContain('const value = (valueField?.value ?? "").trim()')
    // And the xAI block's own save, which had its own copy of the line.
    expect(source).toContain('const value = (field?.value ?? "").trim()')
  })
})
