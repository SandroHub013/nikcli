import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { preserveTestEnv } from "../helpers/env"

// The organization's policy fails closed, so it is read under both names: a policy left in the nikcli place,
// or written in the ragu one, binds either way.
const managedDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragu-guard-rule-b-"))
process.env.RAGU_MANAGED_CONFIG_DIR = managedDir
preserveTestEnv(["RAGU_MANAGED_CONFIG_DIR"])
const { Effect } = await import("effect")
const { ModGuard } = await import("../../src/mod/guard")

afterAll(() => fs.rm(managedDir, { recursive: true, force: true }))

describe("the managed mod policy under both names", () => {
  test("the system folders, ragu and nikcli, on every system", () => {
    const system = (platform: NodeJS.Platform) =>
      ModGuard.managedDirs(platform)
        .filter((entry) => entry.org)
        .map((entry) => entry.dir.replaceAll("\\", "/"))
    expect(system("linux")).toEqual(expect.arrayContaining(["/etc/ragu/managed", "/etc/nikcli/managed"]))
    expect(system("darwin")).toEqual(
      expect.arrayContaining(["/Library/Application Support/ragu/managed", "/Library/Application Support/nikcli/managed"]),
    )
    expect(system("win32").some((dir) => dir.endsWith("/ragu/managed"))).toBe(true)
    expect(system("win32").some((dir) => dir.endsWith("/nikcli/managed"))).toBe(true)
  })

  /*
   * Review of correction 2, point 3: the user's own managed folder, under the config folder, binds from both
   * names, joined, not from rule B's pick: a policy left in nikcli/managed still binds once a ragu folder exists.
   */
  test("the user's managed folder, from both config folders", () => {
    const roaming = path.join("C:", "Users", "u", "AppData", "Roaming")
    const both = [path.join(roaming, "ragu", "managed"), path.join(roaming, "nikcli", "managed")]
    expect(ModGuard.userManagedDirs(path.join(roaming, "ragu"))).toEqual(both)
    expect(ModGuard.userManagedDirs(path.join(roaming, "nikcli"))).toEqual(both)
    // A config folder that is neither (the test home's): itself only.
    expect(ModGuard.userManagedDirs(path.join("/t", "config"))).toEqual([path.join("/t", "config", "managed")])
    const user = ModGuard.managedDirs("win32", path.join(roaming, "ragu")).filter((entry) => !entry.org)
    expect(user.map((entry) => entry.dir)).toEqual(both)
  })

  for (const name of ["ragu.json", "nikcli.json"]) {
    test(`a policy in ${name} binds`, async () => {
      await fs.rm(path.join(managedDir, "ragu.json"), { force: true })
      await fs.rm(path.join(managedDir, "nikcli.json"), { force: true })
      await Bun.write(path.join(managedDir, name), JSON.stringify({ mod: { disableAllMods: true } }))
      const resolved = await Effect.runPromise(ModGuard.read())
      expect(resolved.managed).toBe(true)
      expect(resolved.policy.disableAllMods).toBe(true)
    })
  }
})
