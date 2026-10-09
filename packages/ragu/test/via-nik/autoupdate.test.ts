import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { guardNikFetch } from "../helpers/no-nik-fetch"

/*
 * Brief ragu-via-servizi-nik, package B (6): the update check asked upstream's release feeds (GitHub nikcli/nikcli,
 * npm nikcli-ai, the nikomatt69 brew tap, Chocolatey, Scoop) and installed through upstream's install.ps1 and
 * install script on nikcli-ai.dev: an update from them replaces this fork with nikcli. Gone: the feeds, the
 * installers, the update check, the TUI's update dialog and its worker calls, and the `autoupdate` config key
 * (accepted and ignored). `ragu upgrade` only says where updates come from, without touching the network. How
 * Ragu Code is installed is still detected, for `ragu uninstall`.
 */
const PACKAGES = path.join(import.meta.dir, "../../..")
const read = (file: string) => fs.readFileSync(path.join(PACKAGES, file), "utf8")

const UPSTREAM =
  /nikcli\/nikcli|registry\.npmjs|\/nikcli-ai\/|nikomatt69|chocolatey\.org|ScoopInstaller|formulae\.brew\.sh|install\.ps1|nikcli-ai\.dev\/install/

describe("updates from upstream are gone", () => {
  test("no release feed or installer of upstream in the installation module", () => {
    const lines = read("ragu/src/installation/index.ts")
      .split("\n")
      .filter((line) => UPSTREAM.test(line))
    expect(lines).toEqual([])
  })

  test("no update check, update dialog or worker calls for it", () => {
    for (const file of ["ragu/src/cli/upgrade.ts", "tui/src/context/upgrade.tsx"])
      expect([file, fs.existsSync(path.join(PACKAGES, file))]).toEqual([file, false])
    expect(read("ragu/src/cli/cmd/tui/worker.ts")).not.toMatch(/checkUpgrade|upgradeNow|enableAutoUpdate/)
    expect(read("ragu/src/cli/handlers/default.ts")).not.toMatch(/checkUpgrade|upgradeNow|enableAutoUpdate/)
    expect(read("tui/src/app.tsx")).not.toMatch(/checkUpgrade|upgradeNow|enableAutoUpdate|Update Available/)
  })

  test("the installation service keeps only the method, for uninstall", async () => {
    const { Installation } = await import("@/installation")
    const { Effect } = await import("effect")
    const operations = await Effect.runPromise(
      Effect.gen(function* () {
        return Object.keys(yield* Installation.Service).sort()
      }).pipe(Effect.provide(Installation.defaultLayer)),
    )
    expect(operations).toEqual(["method"])
  })

  test("`ragu upgrade` says where updates come from, without the network", async () => {
    const guard = guardNikFetch()
    try {
      // No version to pick and no install method to choose: there is nothing to install from.
      expect(read("ragu/src/cli/commands.ts")).not.toMatch(/version to upgrade to|installation method to use/)
      const { UPGRADE_NOTICE } = await import("@/cli/handlers/upgrade")
      expect(UPGRADE_NOTICE).toContain("release")
      expect(UPGRADE_NOTICE).not.toMatch(UPSTREAM)
      const source = read("ragu/src/cli/handlers/upgrade.ts")
      expect(source).not.toMatch(/fetch\(|Installation|\$`/)
      expect(guard.attempts).toEqual([])
    } finally {
      guard.restore()
    }
  })
})
