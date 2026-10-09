import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
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
})

/*
 * Review of correction 2, point 1: an exception for `.ragu/plans` let the model create `.ragu` in a project that
 * has only `.nikcli`, and from the next load rule B read `.ragu` and dropped `.nikcli` with its denials. The
 * sub-trees ragu writes itself are open only in the folder in use; nothing makes a `ragu` folder but the user
 * or `ragu migrate`.
 */
describe("the sub-trees ragu writes itself are open in the folder in use only", () => {
  const made: string[] = []
  const project = (...dirs: string[]) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragu-protected-"))
    made.push(root)
    for (const dir of dirs) fs.mkdirSync(path.join(root, dir), { recursive: true })
    return root
  }
  afterAll(() => {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
  })

  test("only .nikcli: its plans and worktrees are open, .ragu's are not", () => {
    const worktree = project(".nikcli")
    for (const file of [".nikcli/plans/a.md", ".nikcli/.worktrees/w/x.ts"])
      expect([file, AutoMode.isProtectedPath(file, worktree)]).toEqual([file, false])
    for (const file of [".ragu/plans/a.md", ".ragu/.worktrees/w/x.ts"])
      expect([file, AutoMode.isProtectedPath(file, worktree)]).toEqual([file, true])
  })

  test("neither folder yet: the old name, where ragu writes them", () => {
    const worktree = project()
    expect(AutoMode.isProtectedPath(".nikcli/plans/a.md", worktree)).toBe(false)
    expect(AutoMode.isProtectedPath(".ragu/plans/a.md", worktree)).toBe(true)
  })

  test("a .ragu there: its plans are open", () => {
    const worktree = project(".ragu", ".nikcli")
    expect(AutoMode.isProtectedPath(".ragu/plans/a.md", worktree)).toBe(false)
    expect(AutoMode.isProtectedPath(".nikcli/plans/a.md", worktree)).toBe(true)
  })

  test("without a worktree, only the old name's (fails closed)", () => {
    expect(AutoMode.isProtectedPath(".nikcli/plans/a.md")).toBe(false)
    expect(AutoMode.isProtectedPath(".ragu/plans/a.md")).toBe(true)
    expect(AutoMode.destructiveCategory("edit", [".ragu/plans/a.md"])).toBe("protected-path")
  })

  test("an edit route in a project with only .nikcli sends .ragu/plans to the classifier", () => {
    const worktree = project(".nikcli")
    const rule = { permission: "edit", pattern: "*", action: "allow" as const }
    const route = (pattern: string) => AutoMode.route({ permission: "edit", pattern, rule, worktree, directory: worktree })
    expect(route(".nikcli/plans/a.md")).toBe("allow")
    expect(route(".ragu/plans/a.md")).toBe("classify")
  })
})

/*
 * Review of correction 2, point 4: on Windows a path is the same file however it is cased, with `::$DATA` (or any
 * `:stream`) after it, and under its 8.3 short name; `serve-rules` already denies those spellings.
 */
describe("a protected path however Windows spells it", () => {
  test("any case", () => {
    for (const file of ["RAGU.JSON", "Nikcli.Jsonc", ".NIKCLI/nikcli.json", ".NIKCLI\\nikcli.json", ".Ragu/tool/x.ts", ".GIT/config", ".VSCode/settings.json"])
      expect([file, AutoMode.isProtectedPath(file)]).toEqual([file, true])
  })

  test("a stream after the name", () => {
    for (const file of ["ragu.json::$DATA", "NIKCLI.JSONC::$data", ".nikcli::$INDEX_ALLOCATION/x.ts", ".git:stream/config", "sub/ragu.json:x"])
      expect([file, AutoMode.isProtectedPath(file)]).toEqual([file, true])
  })

  test("an 8.3 short name", () => {
    for (const file of ["NIKCLI~1/nikcli.json", "nikcli~2\\tool\\x.ts", "RAGU~1/plugin/a.ts", "RAGU~1.JSO", "NIKCLI~1.JSO", "VSCODE~1/settings.json"])
      expect([file, AutoMode.isProtectedPath(file)]).toEqual([file, true])
  })

  test("the rest of the project stays as it was", () => {
    for (const file of ["src/index.ts", "src/ragu.ts", "docs/nikcli.md", "notes~draft.md", "C:/progetto/src/a.ts", "packages/ragu/src/x.ts"])
      expect([file, AutoMode.isProtectedPath(file)]).toEqual([file, false])
  })
})
