import { describe, expect, test } from "bun:test"
import {
  checkName,
  depthOf,
  descendants,
  excludeWithAde,
  modelArgs,
  nameTaken,
  resultsDir,
  slugify,
  withoutModel,
  worktreeArgs,
  worktreePlan,
} from "./orchestra"

describe("names", () => {
  test("a usable name comes back trimmed", () => {
    expect(checkName("  revisore test ")).toEqual({ name: "revisore test" })
  })

  test("names the agent could not address afterwards are refused", () => {
    for (const bad of ["", "   ", "12", "web/api", 'a"b', "x".repeat(41)]) {
      expect("error" in checkName(bad)).toBe(true)
    }
  })

  test("a taken name is taken whatever the case", () => {
    expect(nameTaken(["Revisore", "codex"], "revisore")).toBe(true)
    expect(nameTaken(["Revisore"], "revisore-2")).toBe(false)
  })

  test("slugify makes a branch segment", () => {
    expect(slugify("Revisione più rapida!")).toBe("revisione-piu-rapida")
    expect(slugify("???")).toBe("sessione")
  })
})

test("a worktree goes beside the project, on an ade/ branch", () => {
  expect(worktreePlan("C:\\Users\\me\\Favorites\\nikcli\\", "revisore")).toEqual({
    branch: "ade/revisore",
    path: "C:\\Users\\me\\Favorites\\nikcli-ade\\revisore",
  })
  expect(worktreePlan("/home/me/app", "x")).toEqual({ branch: "ade/x", path: "/home/me/app-ade/x" })
})

describe("the tree of sessions", () => {
  const parents = new Map([
    ["child", "root"],
    ["grandchild", "child"],
    ["sibling", "root"],
  ])
  const parentOf = (id: string) => parents.get(id)

  test("depth counts the spawns above a session", () => {
    expect(depthOf("root", parentOf)).toBe(0)
    expect(depthOf("child", parentOf)).toBe(1)
    expect(depthOf("grandchild", parentOf)).toBe(2)
  })

  test("a cycle ends the count", () => {
    const loop = new Map([
      ["a", "b"],
      ["b", "a"],
    ])
    expect(depthOf("a", (id) => loop.get(id))).toBe(1)
  })

  test("descendants come children-last, so each closes before its parent", () => {
    const below = descendants("root", parents)
    expect(below).toContain("sibling")
    expect(below.indexOf("grandchild")).toBeLessThan(below.indexOf("child"))
    expect(descendants("grandchild", parents)).toEqual([])
  })
})

describe("options a session may choose for its subagent", () => {
  test("the model, with the flag each CLI takes", () => {
    expect(modelArgs("claude-code", "sonnet")).toEqual(["--model", "sonnet"])
    expect(modelArgs("codex", "gpt-5-codex")).toEqual(["-m", "gpt-5-codex"])
    expect(modelArgs("agy", "gemini-3.1-pro-high")).toEqual(["--model", "gemini-3.1-pro-high"])
  })

  test("not a way to smuggle other arguments in", () => {
    expect("error" in (modelArgs("claude-code", "x --dangerously-skip-permissions") as object)).toBe(true)
    expect("error" in (modelArgs("kimi", "k2") as object)).toBe(true)
  })

  test("agy is told about its worktree, the others start in it", () => {
    expect(worktreeArgs("agy", "C:\\w\\x")).toEqual(["--add-dir", "C:\\w\\x"])
    expect(worktreeArgs("codex", "C:\\w\\x")).toEqual([])
  })
})

test("results live in .ade/results, kept out of git once", () => {
  expect(resultsDir("C:\\p\\app")).toBe("C:\\p\\app\\.ade\\results")
  expect(excludeWithAde("*.log")).toBe("*.log\n# ADE: risultati dei subagent\n.ade/\n")
  expect(excludeWithAde("# x\n.ade/\n")).toBeUndefined()
})

test("withoutModel takes the model choice out and leaves the rest", () => {
  expect(withoutModel(["--model", "a", "--add-dir", "C:\\w"])).toEqual(["--add-dir", "C:\\w"])
  expect(withoutModel(["-m", "gpt-5"])).toEqual([])
})