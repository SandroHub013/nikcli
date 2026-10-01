import { describe, expect, test } from "bun:test"
import { isAdeBranch, reclaimWorktree, worktreeWork, type GitRun, type WorktreeFacts } from "./worktree-close"

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

// The branch is listed by `--merged` when the project's branch contains it.
const landed = { "branch --list ade/fix --merged": { stdout: "  ade/fix\n" } }

describe("a session's worktree when its work has landed", () => {
  test("it is removed, and then its branch, in that order, each where it has to run", async () => {
    const { run, calls } = git(landed)
    expect(await reclaimWorktree(run, facts())).toEqual({ kind: "removed", branchDeleted: true })
    expect(calls).toEqual([
      `status --porcelain @ ${TREE}`,
      `branch --list ade/fix --merged @ ${ROOT}`,
      `worktree remove ${TREE} @ ${ROOT}`,
      `branch -d ade/fix @ ${ROOT}`,
    ])
  })

  test("the branch is deleted with -d, never -D: git itself refuses one the project does not contain", async () => {
    const { run, calls } = git(landed)
    await reclaimWorktree(run, facts())
    expect(calls.some((call) => call.startsWith("branch -D"))).toBe(false)
  })

  test("a branch that git will not delete is reported as left, and the worktree is gone all the same", async () => {
    const { run } = git({ ...landed, "branch -d": { code: 1, stderr: "error: the branch is not fully merged" } })
    expect(await reclaimWorktree(run, facts())).toEqual({ kind: "removed", branchDeleted: false })
  })

  test("a branch that is not one of ADE's own is never deleted, even when it is merged", async () => {
    const { run, calls } = git({ "branch --list feature/x --merged": { stdout: "  feature/x\n" } })
    expect(await reclaimWorktree(run, facts({ branch: "feature/x" }))).toEqual({ kind: "removed", branchDeleted: false })
    expect(calls.some((call) => call.startsWith("branch -d"))).toBe(false)
    expect(calls).toContain(`worktree remove ${TREE} @ ${ROOT}`)
  })

  test("with no branch recorded there is nothing to check or delete after the worktree", async () => {
    const { run, calls } = git()
    expect(await reclaimWorktree(run, facts({ branch: undefined }))).toEqual({ kind: "removed", branchDeleted: false })
    expect(calls).toEqual([`status --porcelain @ ${TREE}`, `worktree remove ${TREE} @ ${ROOT}`])
  })
})

describe("a session's worktree with work that has not landed stays, with its branch", () => {
  const destructive = (calls: string[]) => calls.filter((call) => call.startsWith("worktree remove") || call.startsWith("branch -d") || call.startsWith("branch -D"))

  test("changes not committed: nothing destructive runs, and it says where", async () => {
    const { run, calls } = git({ "status --porcelain": { stdout: " M src/app.ts\n" } })
    expect(await reclaimWorktree(run, facts())).toEqual({ kind: "kept", reason: `"Fix" ha modifiche non committate in ${TREE}` })
    expect(destructive(calls)).toEqual([])
  })

  test("a file git does not track yet counts as work too", async () => {
    const { run, calls } = git({ "status --porcelain": { stdout: "?? notes.md\n" } })
    expect((await reclaimWorktree(run, facts())).kind).toBe("kept")
    expect(destructive(calls)).toEqual([])
  })

  test("commits the project's branch does not have: nothing destructive runs", async () => {
    // `--merged` lists nothing: the branch is not contained in the project's.
    const { run, calls } = git({ "branch --list ade/fix --merged": { stdout: "" } })
    expect(await reclaimWorktree(run, facts())).toEqual({ kind: "kept", reason: `"Fix" ha commit sul branch ade/fix non ancora integrati` })
    expect(destructive(calls)).toEqual([])
  })

  test("a worktree git will not remove stays, and its branch with it", async () => {
    const { run, calls } = git({ ...landed, "worktree remove": { code: 128, stderr: "fatal: cannot remove: contains modified or untracked files\n" } })
    expect(await reclaimWorktree(run, facts())).toEqual({
      kind: "kept",
      reason: `"Fix": git non toglie ${TREE} (fatal: cannot remove: contains modified or untracked files)`,
    })
    expect(calls.some((call) => call.startsWith("branch -d"))).toBe(false)
  })

  test("a project that cannot be found: no git command that removes anything", async () => {
    const { run, calls } = git(landed)
    const reclaimed = await reclaimWorktree(run, facts({ root: undefined }))
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
    const result = await reclaimWorktree(run, facts(), { times: 3, ms: 1500, wait: async (ms) => void waits.push(ms) })
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
    const result = await reclaimWorktree(run, facts(), { times: 2, ms: 1, wait: async () => {} })
    expect(result.kind).toBe("kept")
    expect(calls.filter((call) => call.startsWith("worktree remove"))).toHaveLength(3)
    expect(calls.some((call) => call.startsWith("branch -d"))).toBe(false)
  })

  test("with no retry given it asks once", async () => {
    const { run, calls } = git({ ...landed, "worktree remove": { code: 128, stderr: "no" } })
    await reclaimWorktree(run, facts())
    expect(calls.filter((call) => call.startsWith("worktree remove"))).toHaveLength(1)
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
