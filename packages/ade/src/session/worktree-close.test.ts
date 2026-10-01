import { describe, expect, test } from "bun:test"
import { isAdeBranch, noRescue, reclaimWorktree, worktreeWork, type GitRun, type Rescue, type WorktreeFacts } from "./worktree-close"

const ROOT = "C:/work/app"
const TREE = "C:/work/app-worktrees/fix"

const facts = (over: Partial<WorktreeFacts> = {}): WorktreeFacts => ({ title: "Fix", worktree: TREE, branch: "ade/fix", root: ROOT, ...over })

/** A fake git: what each command says, by its arguments; every call is recorded with where it ran. */
function git(says: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}) {
  const calls: string[] = []
  const run: GitRun = async (_command, args, cwd) => {
    const key = args.join(" ")
    calls.push(`${key} @ ${cwd}`)
    const known = Object.entries(says).find(([prefix]) => key === prefix || key.startsWith(`${prefix} `))
    const reply = known?.[1] ?? {}
    return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" }
  }
  return { run, calls }
}

/** A rescue that has nothing to save and says so. */
const rescued: Rescue = async () => 0

// The branch is listed by `--merged` when the project's branch contains it.
const landed = { "branch --list ade/fix --merged": { stdout: "  ade/fix\n" } }

describe("a session's worktree when its work has landed", () => {
  test("it is removed, and then its branch, in that order, each where it has to run", async () => {
    const { run, calls } = git(landed)
    expect(await reclaimWorktree(run, facts(), rescued)).toEqual({ kind: "removed", branchDeleted: true })
    expect(calls).toEqual([
      `status --porcelain @ ${TREE}`,
      `branch --list ade/fix --merged @ ${ROOT}`,
      `worktree remove ${TREE} @ ${ROOT}`,
      `branch -d ade/fix @ ${ROOT}`,
    ])
  })

  test("the branch is deleted with -d, never -D: git itself refuses one the project does not contain", async () => {
    const { run, calls } = git(landed)
    await reclaimWorktree(run, facts(), rescued)
    expect(calls.some((call) => call.startsWith("branch -D"))).toBe(false)
  })

  test("a branch that git will not delete is reported as left, and the worktree is gone all the same", async () => {
    const { run } = git({ ...landed, "branch -d": { code: 1, stderr: "error: the branch is not fully merged" } })
    expect(await reclaimWorktree(run, facts(), rescued)).toEqual({ kind: "removed", branchDeleted: false })
  })

  test("a branch that is not one of ADE's own keeps the worktree: it is the user's, and it is never deleted", async () => {
    const { run, calls } = git({ "branch --list feature/x --merged": { stdout: "  feature/x\n" } })
    const result = await reclaimWorktree(run, facts({ branch: "feature/x" }), rescued)
    expect(result.kind).toBe("kept")
    expect(result.kind === "kept" && result.reason).toContain("feature/x")
    expect(calls.some((call) => call.startsWith("branch -d") || call.startsWith("worktree remove"))).toBe(false)
  })

  test("with no branch recorded the worktree stays: commits on a detached HEAD are in no branch to compare", async () => {
    const { run, calls } = git()
    const result = await reclaimWorktree(run, facts({ branch: undefined }), rescued)
    expect(result.kind).toBe("kept")
    expect(calls).toEqual([`status --porcelain @ ${TREE}`])
  })

  test("when git cannot say whether there are changes, the worktree stays", async () => {
    const { run, calls } = git({ "status --porcelain": { code: 128, stderr: "fatal: not a git repository" }, ...landed })
    const result = await reclaimWorktree(run, facts(), rescued)
    expect(result.kind).toBe("kept")
    expect(calls.some((call) => call.startsWith("worktree remove") || call.startsWith("branch -d"))).toBe(false)
  })

  test("when git cannot say whether the branch has landed, the worktree stays", async () => {
    const { run, calls } = git({ "branch --list ade/fix --merged": { code: 128, stderr: "fatal: bad object" } })
    const result = await reclaimWorktree(run, facts(), rescued)
    expect(result.kind).toBe("kept")
    expect(calls.some((call) => call.startsWith("worktree remove") || call.startsWith("branch -d"))).toBe(false)
  })
})

describe("a session's worktree with work that has not landed stays, with its branch", () => {
  const destructive = (calls: string[]) => calls.filter((call) => call.startsWith("worktree remove") || call.startsWith("branch -d") || call.startsWith("branch -D"))

  test("changes not committed: nothing destructive runs, and it says where", async () => {
    const { run, calls } = git({ "status --porcelain": { stdout: " M src/app.ts\n" } })
    expect(await reclaimWorktree(run, facts(), rescued)).toEqual({ kind: "kept", reason: `"Fix" ha modifiche non committate in ${TREE}` })
    expect(destructive(calls)).toEqual([])
  })

  test("a file git does not track yet counts as work too", async () => {
    const { run, calls } = git({ "status --porcelain": { stdout: "?? notes.md\n" } })
    expect((await reclaimWorktree(run, facts(), rescued)).kind).toBe("kept")
    expect(destructive(calls)).toEqual([])
  })

  test("commits the project's branch does not have: nothing destructive runs", async () => {
    // `--merged` lists nothing: the branch is not contained in the project's.
    const { run, calls } = git({ "branch --list ade/fix --merged": { stdout: "" } })
    expect(await reclaimWorktree(run, facts(), rescued)).toEqual({ kind: "kept", reason: `"Fix" ha commit sul branch ade/fix non ancora integrati` })
    expect(destructive(calls)).toEqual([])
  })

  test("a worktree git will not remove stays, and its branch with it", async () => {
    const { run, calls } = git({ ...landed, "worktree remove": { code: 128, stderr: "fatal: cannot remove: contains modified or untracked files\n" } })
    expect(await reclaimWorktree(run, facts(), rescued)).toEqual({
      kind: "kept",
      reason: `"Fix": git non toglie ${TREE} (fatal: cannot remove: contains modified or untracked files)`,
    })
    expect(calls.some((call) => call.startsWith("branch -d"))).toBe(false)
  })

  test("a project that cannot be found: no git command that removes anything", async () => {
    const { run, calls } = git(landed)
    const reclaimed = await reclaimWorktree(run, facts({ root: undefined }), rescued)
    expect(reclaimed.kind).toBe("kept")
    expect(destructive(calls)).toEqual([])
  })
})

describe("a folder the session's process has not left yet", () => {
  test("git is asked again after a wait, and the second time it works", async () => {
    let removes = 0
    const calls: string[] = []
    const waits: number[] = []
    const run: GitRun = async (_c, args) => {
      calls.push(args.join(" "))
      if (args[0] === "branch" && args[1] === "--list") return { code: 0, stdout: "  ade/fix\n", stderr: "" }
      if (args[0] === "worktree") return ++removes < 2 ? { code: 128, stdout: "", stderr: "fatal: Permission denied\n" } : { code: 0, stdout: "", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    }
    const result = await reclaimWorktree(run, facts(), rescued, { times: 3, ms: 1500, wait: async (ms) => void waits.push(ms) })
    expect(result).toEqual({ kind: "removed", branchDeleted: true })
    expect(waits).toEqual([1500])
    expect(calls.filter((call) => call.startsWith("worktree remove"))).toHaveLength(2)
  })

  test("it gives up after the times it was given, and the worktree stays with its branch", async () => {
    const calls: string[] = []
    const run: GitRun = async (_c, args) => {
      calls.push(args.join(" "))
      if (args[0] === "branch" && args[1] === "--list") return { code: 0, stdout: "  ade/fix\n", stderr: "" }
      return args[0] === "worktree" ? { code: 128, stdout: "", stderr: "fatal: Permission denied\n" } : { code: 0, stdout: "", stderr: "" }
    }
    const result = await reclaimWorktree(run, facts(), rescued, { times: 2, ms: 1, wait: async () => {} })
    expect(result.kind).toBe("kept")
    expect(calls.filter((call) => call.startsWith("worktree remove"))).toHaveLength(3)
    expect(calls.some((call) => call.startsWith("branch -d"))).toBe(false)
  })

  test("with no retry given it asks once", async () => {
    const { run, calls } = git({ ...landed, "worktree remove": { code: 128, stderr: "no" } })
    await reclaimWorktree(run, facts(), rescued)
    expect(calls.filter((call) => call.startsWith("worktree remove"))).toHaveLength(1)
  })
})

describe("what the session wrote under its worktree's .ade/", () => {
  /** A fake git and a rescue that write into one log, so the order of the two can be read. */
  function logged(rescue: (log: string[]) => Promise<number>, says: Parameters<typeof git>[0] = landed) {
    const log: string[] = []
    const { run } = git(says)
    const wrapped: GitRun = async (command, args, cwd) => {
      log.push(`git ${args.join(" ")}`)
      return run(command, args, cwd)
    }
    return { log, run: wrapped, rescue: (async (root, worktree) => {
      log.push(`rescue ${root} ${worktree}`)
      return rescue(log)
    }) as Rescue }
  }

  test("is saved into the project before the worktree is removed, and before its branch", async () => {
    const { log, run, rescue } = logged(async () => 2)
    expect(await reclaimWorktree(run, facts(), rescue)).toEqual({ kind: "removed", branchDeleted: true })
    const at = (what: string) => log.findIndex((line) => line.startsWith(what))
    expect(log).toContain(`rescue ${ROOT} ${TREE}`)
    expect(at("rescue")).toBeGreaterThan(at("git status"))
    expect(at("rescue")).toBeLessThan(at("git worktree remove"))
    expect(at("git worktree remove")).toBeLessThan(at("git branch -d"))
  })

  test("when it cannot be saved the worktree stays, with its branch, and nothing is removed", async () => {
    const { log, run, rescue } = logged(async () => {
      throw new Error("il disco è pieno")
    })
    const result = await reclaimWorktree(run, facts(), rescue)
    expect(result.kind).toBe("kept")
    expect(result.kind === "kept" && result.reason).toContain("il disco è pieno")
    expect(result.kind === "kept" && result.reason).toContain(TREE)
    expect(log.some((line) => line.startsWith("git worktree remove") || line.startsWith("git branch -d"))).toBe(false)
  })

  test("a host that cannot save them keeps the worktree rather than lose them", async () => {
    const { run, calls } = git(landed)
    const result = await reclaimWorktree(run, facts(), noRescue)
    expect(result.kind).toBe("kept")
    expect(calls.some((call) => call.startsWith("worktree remove"))).toBe(false)
  })

  test("nothing is saved when the work has not landed: that worktree is not touched at all", async () => {
    const { log, run, rescue } = logged(async () => 1, { "status --porcelain": { stdout: " M a.ts\n" } })
    expect((await reclaimWorktree(run, facts(), rescue)).kind).toBe("kept")
    expect(log.some((line) => line.startsWith("rescue"))).toBe(false)
  })

  test("a moment of failure is tried again, as the removal is, while the session's process leaves its files", async () => {
    let tries = 0
    const waits: number[] = []
    const { run, rescue } = logged(async () => {
      if (++tries < 3) throw new Error("file aperto")
      return 1
    })
    const result = await reclaimWorktree(run, facts(), rescue, { times: 3, ms: 1500, wait: async (ms) => void waits.push(ms) })
    expect(result).toEqual({ kind: "removed", branchDeleted: true })
    expect(tries).toBe(3)
    expect(waits).toEqual([1500, 1500])
  })

  test("a failure that does not pass is not tried for ever", async () => {
    let tries = 0
    const { run, rescue } = logged(async () => {
      tries++
      throw new Error("no")
    })
    const result = await reclaimWorktree(run, facts(), rescue, { times: 2, ms: 1, wait: async () => {} })
    expect(result.kind).toBe("kept")
    expect(tries).toBe(3)
  })
})

describe("what is asked before a close", () => {
  test("clean and landed: nothing in the way", async () => {
    const { run } = git(landed)
    expect(await worktreeWork(run, facts())).toBeUndefined()
  })

  test("a status that says only blanks is clean", async () => {
    const { run } = git({ "status --porcelain": { stdout: "\n  \n" }, ...landed })
    expect(await worktreeWork(run, facts())).toBeUndefined()
  })

  test("it only asks, it never removes", async () => {
    const { run, calls } = git({ "status --porcelain": { stdout: " M a\n" } })
    await worktreeWork(run, facts())
    expect(calls).toEqual([`status --porcelain @ ${TREE}`])
  })
})

describe("which branches are ADE's own", () => {
  test("only ade/<something>", () => {
    expect(isAdeBranch("ade/fix")).toBe(true)
    expect(isAdeBranch("ade/")).toBe(false)
    expect(isAdeBranch("ade")).toBe(false)
    expect(isAdeBranch("feature/ade/x")).toBe(false)
    expect(isAdeBranch("main")).toBe(false)
    expect(isAdeBranch(undefined)).toBe(false)
  })
})
