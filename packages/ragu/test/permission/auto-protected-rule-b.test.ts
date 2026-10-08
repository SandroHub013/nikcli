import { describe, expect, test } from "bun:test"
import { AutoMode } from "../../src/permission/auto"

// Rule B (`@ragu/util/app-folder`): a project's config is .ragu or .nikcli, ragu.json(c) or nikcli.json(c), and
// auto mode must never let the model write either, under either name.
describe("auto mode protects a user's configuration under both names", () => {
  test("the folders", () => {
    for (const file of [".ragu/tool/x.ts", ".nikcli/tool/x.ts", "sub/.ragu/plugin/a.ts", "/abs/.nikcli/agent/b.md"]) {
      expect([file, AutoMode.isProtectedPath(file)]).toEqual([file, true])
    }
  })

  test("the files", () => {
    for (const file of ["ragu.json", "ragu.jsonc", "nikcli.json", "nikcli.jsonc", "pkg/ragu.json"]) {
      expect([file, AutoMode.isProtectedPath(file)]).toEqual([file, true])
    }
  })

  test("the sub-trees ragu writes itself stay open, under both names", () => {
    for (const file of [".ragu/plans/a.md", ".nikcli/plans/a.md", ".ragu/.worktrees/w/x.ts", ".nikcli/.worktrees/w/x.ts"]) {
      expect([file, AutoMode.isProtectedPath(file)]).toEqual([file, false])
    }
  })
})
