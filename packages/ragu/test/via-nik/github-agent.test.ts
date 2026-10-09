import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package B (5): `ragu github install` asked api.nikcli-ai.dev whether Nik's GitHub
 * App was installed and wrote a workflow running Nik's action; `ragu github run` was never implemented. Both
 * served only that backend: the command goes.
 */
describe("the GitHub agent of Nik's backend is gone", () => {
  test("no `ragu github` command and no handlers", async () => {
    const { Commands } = await import("@/cli/commands")
    expect(Object.keys(Commands.commands)).not.toContain("github")
    expect(fs.existsSync(path.join(import.meta.dir, "../../src/cli/handlers/github"))).toBe(false)
  })
})
