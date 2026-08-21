import { describe, expect, test } from "bun:test"
import type { Host } from "../host/shell"
import { collectConflicts, planIntegration, runIntegration } from "./integrate"

function host(run: (args: string[], cwd?: string) => { code: number; stdout: string; stderr: string }): Host {
  return {
    probe: async () => null,
    run: async (_command: string, args: string[], cwd?: string) => run(args, cwd),
    linkDirectory: async () => null,
    spawn: async () => ({ kill: () => {}, write: () => {} }),
  } as unknown as Host
}

const clean = { treeDirty: 0, projectDirty: 0, ahead: 1 }

describe("planIntegration", () => {
  test("merge keeps the session visible as its own commit", () => {
    const plan = planIntegration({ branch: "s1", onto: "main", mode: "merge", ...clean })

    expect(plan.steps).toEqual([
      { args: ["merge", "--no-ff", "-m", "Merge branch 's1'", "s1"], cwd: "project" },
    ])
    expect(plan.warnings).toEqual([])
  })

  test("rebase does not re-checkout a branch the tree is already on", () => {
    const plan = planIntegration({ branch: "s1", onto: "main", mode: "rebase", ...clean })

    expect(plan.steps).toEqual([
      { args: ["rebase", "main"], cwd: "tree" },
      { args: ["merge", "--ff-only", "s1"], cwd: "project" },
    ])
  })

  test("uncommitted work in the session becomes a commit before anything moves", () => {
    const plan = planIntegration({
      branch: "s1",
      onto: "main",
      mode: "merge",
      treeDirty: 3,
      projectDirty: 0,
      ahead: 0,
    })

    expect(plan.steps[0]).toEqual({ args: ["add", "-A"], cwd: "tree" })
    expect(plan.steps[1].args[0]).toBe("commit")
    expect(plan.summary).toStartWith("Committa il lavoro non salvato")
  })

  test("a session that produced nothing says so", () => {
    const plan = planIntegration({
      branch: "s1",
      onto: "main",
      mode: "merge",
      treeDirty: 0,
      projectDirty: 0,
      ahead: 0,
    })

    expect(plan.warnings).toContain("La sessione non ha prodotto niente da integrare.")
  })

  /*
   * The case the first version got wrong: `patch` is `merge --squash`, which
   * writes into the project's working tree and stops on a dirty one exactly
   * like the others. Calling it the safe mode would be the wrong reassurance.
   */
  test("a dirty project is a warning in every mode, patch included", () => {
    for (const mode of ["merge", "rebase", "cherry-pick", "patch"] as const) {
      const plan = planIntegration({
        branch: "s1",
        onto: "main",
        mode,
        treeDirty: 0,
        projectDirty: 2,
        ahead: 1,
      })
      expect(plan.warnings.length).toBeGreaterThan(0)
    }
  })

  test("no plan may contain a step that discards work", () => {
    for (const mode of ["merge", "rebase", "cherry-pick", "patch"] as const) {
      const plan = planIntegration({ branch: "s1", onto: "main", mode, ...clean })
      for (const step of plan.steps) {
        expect(step.args).not.toContain("--force")
        expect(step.args).not.toContain("--hard")
      }
    }
  })
})

describe("runIntegration", () => {
  test("runs every step and reports success", async () => {
    const seen: string[][] = []
    const result = await runIntegration({
      host: host((args) => {
        seen.push(args)
        return { code: 0, stdout: "", stderr: "" }
      }),
      projectPath: "/proj",
      treePath: "/tree",
      plan: planIntegration({ branch: "s1", onto: "main", mode: "rebase", ...clean }),
    })

    expect(result.ok).toBe(true)
    expect(seen).toHaveLength(2)
  })

  test("stops at the first failure and quotes git", async () => {
    const result = await runIntegration({
      host: host((args) =>
        args[0] === "rebase"
          ? { code: 1, stdout: "", stderr: "fatal: no rebase in progress\n" }
          : { code: 0, stdout: "", stderr: "" },
      ),
      projectPath: "/proj",
      treePath: "/tree",
      plan: planIntegration({ branch: "s1", onto: "main", mode: "rebase", ...clean }),
    })

    expect(result.ok).toBe(false)
    expect(result.failedStep).toBe("git rebase main")
    expect(result.reason).toBe("fatal: no rebase in progress")
    expect(result.conflict).toBe(false)
  })

  /*
   * Conflict detection asks the repository, never git's prose: a user whose
   * git speaks Italian never sees the word CONFLICT.
   */
  test("recognises a conflict from the repository, not from the message language", async () => {
    const result = await runIntegration({
      host: host((args) => {
        if (args[0] === "merge") {
          return { code: 1, stdout: "", stderr: "CONFLITTO (contenuto): merge non riuscito\n" }
        }
        if (args[0] === "status") {
          return { code: 0, stdout: "UU src/a.ts\nUD src/b.ts\n M src/c.ts\n", stderr: "" }
        }
        return { code: 0, stdout: "", stderr: "" }
      }),
      projectPath: "/proj",
      treePath: "/tree",
      plan: planIntegration({ branch: "s1", onto: "main", mode: "merge", ...clean }),
    })

    expect(result.conflict).toBe(true)
    expect(result.conflicts).toEqual(["src/a.ts", "src/b.ts"])
  })
})

describe("collectConflicts", () => {
  test("takes only the unmerged states", () => {
    const status = ["UU uno.txt", "AA due.txt", "DU tre.txt", " M pulito.txt", "?? nuovo.txt"].join("\n")
    expect(collectConflicts(status)).toEqual(["uno.txt", "due.txt", "tre.txt"])
  })

  test("unquotes paths git had to quote", () => {
    expect(collectConflicts('UU "con spazi.txt"\n')).toEqual(["con spazi.txt"])
  })

  test("survives empty and truncated output", () => {
    expect(collectConflicts("")).toEqual([])
    expect(collectConflicts("UU\n")).toEqual([])
  })
})
