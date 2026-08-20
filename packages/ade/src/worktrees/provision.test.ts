import { describe, expect, test } from "bun:test"
import type { Host } from "../host/shell"
import type { Worktree } from "./model"
import { provisionSessionTree } from "./provision"

/*
 * Fidelity is the one value the pane keeps showing after the provisioning note
 * has scrolled away, so it is what a user relies on to answer "which of my
 * sessions is about to edit my real project". A wrong fidelity is worse than a
 * missing one: it is a reassurance that is not true.
 */

/** A host whose git answers are scripted per subcommand. */
function makeHost(input: {
  fail?: "stage" | "write-tree" | "commit-tree" | "worktree-add"
  linkError?: string
}): { host: Host; commands: string[][] } {
  const commands: string[][] = []
  const host: Host = {
    probe: async () => null,
    run: async (_cmd, args) => {
      commands.push(args)
      const step = args[0]
      const failing =
        (input.fail === "stage" && step === "add") ||
        (input.fail === "write-tree" && step === "write-tree") ||
        (input.fail === "commit-tree" && step === "commit-tree") ||
        (input.fail === "worktree-add" && step === "worktree")
      if (failing) return { code: 1, stdout: "", stderr: "git ha rifiutato" }
      if (step === "write-tree") return { code: 0, stdout: "tree0000\n", stderr: "" }
      if (step === "commit-tree") return { code: 0, stdout: "commit0000\n", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    },
    linkDirectory: async () => input.linkError ?? null,
    spawn: async () => ({ kill: () => {}, write: () => {} }),
  }
  return { host, commands }
}

const base = {
  projectId: "proj-1",
  projectPath: "C:/repo/proj-1",
  sessionId: "session-1",
  agentId: "agy",
  baseBranch: "HEAD",
}

describe("provisionSessionTree fidelity", () => {
  test("a snapshot tree with linked dependencies is 'full'", async () => {
    const { host, commands } = makeHost({})
    const result = await provisionSessionTree({ ...base, host, trees: [] })

    expect(result.fidelity).toBe("full")
    expect(result.created).toBe(true)
    expect(result.branch).toBe("ade/agy/session-1")
    // The worktree must be based on the snapshot commit, never on the raw base
    // branch: that is the whole point — the tree has to carry uncommitted work.
    const add = commands.find((args) => args[0] === "worktree")
    expect(add?.at(-1)).toBe("commit0000")
  })

  test("the checkout is placed under .ade-trees, absolutely", async () => {
    const { host, commands } = makeHost({})
    const result = await provisionSessionTree({ ...base, host, trees: [] })

    // Regression: the plan carries a bare NAME, and `git worktree add` resolves
    // a relative path against the process it runs in — so an unqualified name
    // put the checkout wherever the caller stood, outside the one directory
    // .gitignore hides and the snapshot pathspec excludes.
    const add = commands.find((args) => args[0] === "worktree")
    expect(add?.[4]).toBe("C:/repo/proj-1/.ade-trees/proj-1-agy-session-1")
    // The same string becomes the agent's working directory.
    expect(result.cwd).toBe("C:/repo/proj-1/.ade-trees/proj-1-agy-session-1")
  })

  test("a failed snapshot leaves the tree at the last commit, so it is 'stale'", async () => {
    const { host, commands } = makeHost({ fail: "write-tree" })
    const result = await provisionSessionTree({ ...base, host, trees: [] })

    expect(result.fidelity).toBe("stale")
    expect(result.created).toBe(true)
    // Degraded, not failed: the tree is still created, on the base branch.
    const add = commands.find((args) => args[0] === "worktree")
    expect(add?.at(-1)).toBe("HEAD")
    expect(result.note).toContain("non le modifiche non salvate")
  })

  test("unlinkable dependencies are 'no-deps', not a failure", async () => {
    const { host } = makeHost({ linkError: "accesso negato" })
    const result = await provisionSessionTree({ ...base, host, trees: [] })

    expect(result.fidelity).toBe("no-deps")
    expect(result.created).toBe(true)
  })

  test("missing work outranks missing tooling when both degrade", async () => {
    const { host } = makeHost({ fail: "commit-tree", linkError: "accesso negato" })
    const result = await provisionSessionTree({ ...base, host, trees: [] })

    // An agent in a stale tree edits code the user cannot see; one without
    // dependencies edits the right code and merely cannot run it.
    expect(result.fidelity).toBe("stale")
  })

  test("a refused worktree means no isolation at all, and says so", async () => {
    const { host } = makeHost({ fail: "worktree-add" })
    const result = await provisionSessionTree({ ...base, host, trees: [] })

    expect(result.fidelity).toBe("project")
    expect(result.created).toBe(false)
    expect(result.cwd).toBe(base.projectPath)
  })

  test("the project's own branch is reported when running without a tree", async () => {
    const { host } = makeHost({ fail: "worktree-add" })
    const projectTree: Worktree = {
      id: "wt-main",
      projectId: "proj-1",
      name: "principale",
      path: "C:/repo/proj-1",
      branch: "feat/qualcosa",
      ahead: 0,
      behind: 0,
      dirty: 12,
      occupants: [],
      updatedAt: 0,
    }

    const result = await provisionSessionTree({ ...base, host, trees: [projectTree] })

    expect(result.branch).toBe("feat/qualcosa")
  })

  test("a reused clean tree sits at its branch tip, so it is 'stale' not 'full'", async () => {
    const { host } = makeHost({})
    const reusable: Worktree = {
      id: "wt-clean",
      projectId: "proj-1",
      name: "libero",
      path: "C:/repo/proj-1/libero",
      branch: "ade/agy/precedente",
      ahead: 0,
      behind: 0,
      dirty: 0,
      occupants: [],
      updatedAt: 0,
    }

    const result = await provisionSessionTree({ ...base, host, trees: [reusable] })

    expect(result.fidelity).toBe("stale")
    expect(result.branch).toBe("ade/agy/precedente")
  })
})
