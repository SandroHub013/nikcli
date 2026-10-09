import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { runPromiseWithLayer, withCurrentInstance } from "../../src/effect"
import { Instance } from "../../src/project/instance"

/*
 * Review of correction 2, point 1: the plan agent could write `.ragu/plans/x.md` in a project that has only
 * `.nikcli`; that made `.ragu`, and from the next load rule B read it and dropped `.nikcli` with its denials.
 * The plan agent writes its plans in the folder in use only.
 */
const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "ragu-plan-folder-home-"))
process.env.RAGU_TEST_HOME = testHome
process.env.RAGU_DISABLE_PROJECT_CONFIG = "1"

preserveTestEnv(["RAGU_TEST_HOME", "RAGU_DISABLE_PROJECT_CONFIG"])

const { Agent } = await import("../../src/agent/agent")
const { PermissionNext } = await import("../../src/permission/next")

const projectDirs: string[] = []

async function planEdit(dirs: string[], file: string) {
  const projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ragu-plan-folder-")))
  projectDirs.push(projectDir)
  for (const dir of dirs) await fs.mkdir(path.join(projectDir, dir), { recursive: true })
  // A repository: the worktree is the project, where its plans go (`Session.plan`).
  Bun.spawnSync(["git", "init", "-q"], { cwd: projectDir })
  return Instance.provide({
    directory: projectDir,
    fn: async () => {
      const plan = await runPromiseWithLayer(
        Agent.defaultLayer,
        withCurrentInstance(
          Effect.gen(function* () {
            const agent = yield* Agent.Service
            return yield* agent.get("plan")
          }),
        ),
      )
      return PermissionNext.evaluate("edit", file, plan!.permission).action
    },
  })
}

afterEach(async () => {
  await Instance.disposeAll().catch(() => undefined)
})

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  await Promise.all(projectDirs.map((dir) => removeTestDir(dir)))
  const { Database } = await import("@/database/database")
  Database.closeAll()
  await removeTestDir(testHome)
})

describe("the plan agent writes its plans in the folder in use", () => {
  it("only .nikcli: .nikcli/plans, never .ragu/plans", async () => {
    expect(await planEdit([".nikcli"], path.join(".nikcli", "plans", "a.md"))).toBe("allow")
    expect(await planEdit([".nikcli"], path.join(".ragu", "plans", "a.md"))).toBe("deny")
  })

  it("neither folder: the old name", async () => {
    expect(await planEdit([], path.join(".nikcli", "plans", "a.md"))).toBe("allow")
    expect(await planEdit([], path.join(".ragu", "plans", "a.md"))).toBe("deny")
  })

  it("a .ragu there: .ragu/plans", async () => {
    expect(await planEdit([".ragu"], path.join(".ragu", "plans", "a.md"))).toBe("allow")
  })
})
