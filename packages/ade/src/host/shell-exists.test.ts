import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Full review 2026-10-06, sessions 16: `exists` answered `false` for every failure, so a share whose VPN was still off made
// a project «gone». It rejects now; the callers that mean «assume it is there» `catch` (`rootMissing`, `missingRecents`).
describe("host.exists", () => {
  test("does not turn a failed check into «not there»", () => {
    const source = readFileSync(join(__dirname, "shell.ts"), "utf-8")
    const at = source.indexOf("async exists(path)")
    const body = source.slice(at, source.indexOf("\n    },", at))
    expect(body).toContain('invoke<boolean>("path_exists"')
    expect(body).not.toMatch(/catch\s*[({]/)
  })
})
