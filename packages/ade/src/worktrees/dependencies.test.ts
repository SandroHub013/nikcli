import { beforeEach, describe, expect, test } from "bun:test"
import type { Host, RunResult } from "../host/shell"
import { planDependencyLinks } from "./dependencies"
import type { Worktree } from "./model"
import { provisionSessionTree } from "./provision"

describe("planDependencyLinks", () => {
  test("always plans the root link with an empty package list", () => {
    const links = planDependencyLinks({
      projectPath: "/repo/my-project",
      worktreePath: "/repo/my-project-wt",
      packageDirs: [],
    })

    expect(links).toEqual([
      {
        target: "node_modules",
        source: "/repo/my-project/node_modules",
      },
    ])
  })

  test("each package directory gets its own link in addition to the root", () => {
    const links = planDependencyLinks({
      projectPath: "/repo/my-project",
      worktreePath: "/repo/my-project-wt",
      packageDirs: ["packages/ade", "packages/app", "packages/desktop"],
    })

    expect(links).toEqual([
      {
        target: "node_modules",
        source: "/repo/my-project/node_modules",
      },
      {
        target: "packages/ade/node_modules",
        source: "/repo/my-project/packages/ade/node_modules",
      },
      {
        target: "packages/app/node_modules",
        source: "/repo/my-project/packages/app/node_modules",
      },
      {
        target: "packages/desktop/node_modules",
        source: "/repo/my-project/packages/desktop/node_modules",
      },
    ])
  })

  test("joins paths without doubling or dropping separators", () => {
    // Trailing slash on projectPath
    const linksWithTrailing = planDependencyLinks({
      projectPath: "/repo/my-project/",
      worktreePath: "/repo/my-project-wt/",
      packageDirs: ["packages/ade/"],
    })

    expect(linksWithTrailing).toEqual([
      {
        target: "node_modules",
        source: "/repo/my-project/node_modules",
      },
      {
        target: "packages/ade/node_modules",
        source: "/repo/my-project/packages/ade/node_modules",
      },
    ])

    // Multiple trailing slashes on projectPath
    const linksWithMultipleSlashes = planDependencyLinks({
      projectPath: "/repo/my-project///",
      worktreePath: "/repo/my-project-wt///",
      packageDirs: ["packages/ade"],
    })

    expect(linksWithMultipleSlashes[0].source).toBe("/repo/my-project/node_modules")
    expect(linksWithMultipleSlashes[1].source).toBe("/repo/my-project/packages/ade/node_modules")
  })

  test("produces correct targets when package directory has trailing slash or backslash", () => {
    const links = planDependencyLinks({
      projectPath: "C:/Users/dev/repo",
      worktreePath: "C:/Users/dev/repo-wt",
      packageDirs: [
        "packages/ade/",
        "packages\\app\\",
        "/packages/desktop/",
        ".\\packages\\tui\\",
      ],
    })

    expect(links).toEqual([
      {
        target: "node_modules",
        source: "C:/Users/dev/repo/node_modules",
      },
      {
        target: "packages/ade/node_modules",
        source: "C:/Users/dev/repo/packages/ade/node_modules",
      },
      {
        target: "packages/app/node_modules",
        source: "C:/Users/dev/repo/packages/app/node_modules",
      },
      {
        target: "packages/desktop/node_modules",
        source: "C:/Users/dev/repo/packages/desktop/node_modules",
      },
      {
        target: "packages/tui/node_modules",
        source: "C:/Users/dev/repo/packages/tui/node_modules",
      },
    ])
  })

  test("handles Windows backslashes in projectPath correctly", () => {
    const links = planDependencyLinks({
      projectPath: "C:\\Users\\dev\\workspace\\project\\",
      worktreePath: "C:\\Users\\dev\\workspace\\project-session\\",
      packageDirs: ["packages\\ade\\"],
    })

    expect(links).toEqual([
      {
        target: "node_modules",
        source: "C:/Users/dev/workspace/project/node_modules",
      },
      {
        target: "packages/ade/node_modules",
        source: "C:/Users/dev/workspace/project/packages/ade/node_modules",
      },
    ])
  })

  test("deduplicates identical package targets and ignores redundant root references", () => {
    const links = planDependencyLinks({
      projectPath: "/repo/my-project",
      worktreePath: "/repo/my-project-wt",
      packageDirs: [
        "packages/ade",
        "packages/ade/",
        "packages\\ade",
        "",
        ".",
        "./",
      ],
    })

    expect(links).toEqual([
      {
        target: "node_modules",
        source: "/repo/my-project/node_modules",
      },
      {
        target: "packages/ade/node_modules",
        source: "/repo/my-project/packages/ade/node_modules",
      },
    ])
  })
})

describe("provisionSessionTree dependency linking", () => {
  // Links are recorded rather than made: the point of these tests is which
  // links get planned and when, not whether the filesystem cooperates.
  const linked: { link: string; target: string }[] = []

  function makeMockHost(
    runner: (cmd: string, args: string[], cwd?: string) => RunResult,
    linkError?: string,
  ): Host {
    return {
      probe: async () => null,
      run: async (cmd, args, cwd) => runner(cmd, args, cwd),
      linkDirectory: async (link, target) => {
        linked.push({ link, target })
        return linkError ?? null
      },
      spawn: async () => ({
        kill: () => {},
        write: () => {},
      }),
    }
  }

  beforeEach(() => {
    linked.length = 0
  })

  test("does not link dependencies when reusing an existing clean tree", async () => {
    const executedCommands: { cmd: string; args: string[]; cwd?: string }[] = []
    const host = makeMockHost((cmd, args, cwd) => {
      executedCommands.push({ cmd, args, cwd })
      return { code: 0, stdout: "", stderr: "" }
    })

    const existingTree: Worktree = {
      id: "wt-clean",
      projectId: "proj-1",
      name: "clean-tree",
      path: "/repo/proj-1/clean-tree",
      branch: "ade/agy/clean",
      ahead: 0,
      behind: 0,
      dirty: 0,
      occupants: [],
      updatedAt: 500,
    }

    const result = await provisionSessionTree({
      host,
      projectId: "proj-1",
      projectPath: "/repo/proj-1",
      trees: [existingTree],
      sessionId: "session-1",
      agentId: "agy",
      baseBranch: "main",
    })

    expect(result.created).toBe(false)
    expect(result.cwd).toBe(existingTree.path)
    expect(executedCommands.length).toBe(0)
  })

  test("creates dependency links when a fresh worktree is created", async () => {
    const executedCommands: { cmd: string; args: string[]; cwd?: string }[] = []
    const host = makeMockHost((cmd, args, cwd) => {
      executedCommands.push({ cmd, args, cwd })
      return { code: 0, stdout: "", stderr: "" }
    })

    const result = await provisionSessionTree({
      host,
      projectId: "proj-1",
      projectPath: "C:/Users/dev/proj-1",
      trees: [],
      sessionId: "session-1",
      agentId: "agy",
      baseBranch: "main",
      packageDirs: ["packages/ade"],
    })

    expect(result.created).toBe(true)
    // git creates the tree and snapshots; the links go through the dedicated command, never
    // through a shell - putting `cmd` on the allowlist would be arbitrary
    // execution for anything this window loads.
    expect(executedCommands.length).toBeGreaterThanOrEqual(1)
    expect(executedCommands.every((c) => c.cmd === "git")).toBe(true)
    expect(linked.length).toBe(2)
    expect(linked[0].link).toContain("node_modules")
    expect(linked[1].link).toContain("packages/ade/node_modules")
    expect(result.note).not.toContain("Dipendenze non collegate")
  })

  test("appends failure reason in Italian to note when dependency links fail", async () => {
    const host = makeMockHost(() => ({ code: 0, stdout: "", stderr: "" }), "Access is denied.")

    const result = await provisionSessionTree({
      host,
      projectId: "proj-1",
      projectPath: "C:/Users/dev/proj-1",
      trees: [],
      sessionId: "session-1",
      agentId: "agy",
      baseBranch: "main",
      packageDirs: ["packages/ade"],
    })

    expect(result.created).toBe(true)
    expect(result.note).toContain("Dipendenze non collegate")
    expect(result.note).toContain("node_modules (Access is denied.)")
    expect(result.note).toContain("packages/ade/node_modules (Access is denied.)")
  })
})
