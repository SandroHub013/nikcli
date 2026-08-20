import { describe, expect, test } from "bun:test"
import { countDirty, parseAheadBehind, parseWorktreeList, shortBranch, treeName } from "./git"

const PORCELAIN = `worktree C:/Users/x/nikcli
HEAD 1111111111111111111111111111111111111111
branch refs/heads/live-main

worktree C:/Users/x/nikcli-contrasto
HEAD 2222222222222222222222222222222222222222
branch refs/heads/fix/wcag-token-contrast

worktree C:/Users/x/nikcli-detached
HEAD 3333333333333333333333333333333333333333
detached
`

describe("parseWorktreeList", () => {
  test("reads one record per tree", () => {
    const trees = parseWorktreeList(PORCELAIN)
    expect(trees.length).toBe(3)
    expect(trees[0].path).toBe("C:/Users/x/nikcli")
    expect(trees[0].branch).toBe("live-main")
  })

  test("a branch with slashes keeps them", () => {
    const trees = parseWorktreeList(PORCELAIN)
    expect(trees[1].branch).toBe("fix/wcag-token-contrast")
  })

  test("a detached tree has no branch and says so", () => {
    const trees = parseWorktreeList(PORCELAIN)
    expect(trees[2].detached).toBe(true)
    expect(trees[2].branch).toBeUndefined()
  })

  test("the last record survives a file with no trailing blank line", () => {
    const trees = parseWorktreeList("worktree /a\nHEAD 1\nbranch refs/heads/main")
    expect(trees.length).toBe(1)
    expect(trees[0].branch).toBe("main")
  })

  test("a path containing spaces is not split", () => {
    const trees = parseWorktreeList("worktree /c/Program Files/repo\nHEAD 1\nbranch refs/heads/main\n")
    expect(trees[0].path).toBe("/c/Program Files/repo")
  })

  test("carriage returns from a Windows pipe do not end up in values", () => {
    const trees = parseWorktreeList("worktree /a\r\nHEAD 1\r\nbranch refs/heads/main\r\n")
    expect(trees[0].branch).toBe("main")
    expect(trees[0].path).toBe("/a")
  })

  test("an unknown attribute does not discard the tree", () => {
    const trees = parseWorktreeList("worktree /a\nHEAD 1\nbranch refs/heads/main\nprunable gitdir file points to non-existent location\n")
    expect(trees.length).toBe(1)
    expect(trees[0].branch).toBe("main")
  })

  test("locked is recorded, because a locked tree cannot be reused", () => {
    const trees = parseWorktreeList("worktree /a\nHEAD 1\nbranch refs/heads/main\nlocked\n")
    expect(trees[0].locked).toBe(true)
  })
})

describe("shortBranch", () => {
  test("strips the ref prefix and nothing else", () => {
    expect(shortBranch("refs/heads/feat/x")).toBe("feat/x")
    expect(shortBranch("feat/x")).toBe("feat/x")
  })
})

describe("treeName", () => {
  test("the project's own tree is named for what it is", () => {
    expect(treeName("C:/x/repo", "C:/x/repo")).toBe("principale")
  })

  test("any other tree is named by its last segment, on both separators", () => {
    expect(treeName("C:/x/repo-wt", "C:/x/repo")).toBe("repo-wt")
    expect(treeName("C:\\x\\repo-wt", "C:/x/repo")).toBe("repo-wt")
  })

  test("a trailing separator does not produce an empty name", () => {
    expect(treeName("C:/x/repo-wt/", "C:/x/repo")).toBe("repo-wt")
  })
})

describe("countDirty", () => {
  test("counts one per changed path and ignores blank lines", () => {
    expect(countDirty(" M a.ts\n?? b.ts\n\n")).toBe(2)
    expect(countDirty("")).toBe(0)
  })
})

describe("parseAheadBehind", () => {
  test("reads behind first, then ahead, as git prints them", () => {
    expect(parseAheadBehind("3\t5\n")).toEqual({ behind: 3, ahead: 5 })
  })

  test("a tree with no upstream reports neither, rather than guessing", () => {
    expect(parseAheadBehind("fatal: no upstream configured")).toEqual({ ahead: 0, behind: 0 })
    expect(parseAheadBehind("")).toEqual({ ahead: 0, behind: 0 })
  })
})
