import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package B, review B2: the TUI tips, the help dialog and `ragu doctor` still offered
 * commands that are gone or no longer do what they say. `ragu github install` was removed with Nik's GitHub App, and
 * `ragu upgrade` no longer updates anything: it says updates come from the fork's releases.
 */
const PACKAGES = path.join(import.meta.dir, "../../..")
const read = (file: string) => fs.readFileSync(path.join(PACKAGES, file), "utf8")

describe("no hints at removed or changed commands", () => {
  test("no tip suggests ragu github install or ragu upgrade as an updater", () => {
    for (const file of ["tui/src/component/tips.tsx", "tui/src/feature-plugins/home/tips-view.tsx"]) {
      const source = read(file)
      expect([file, /ragu github install/.test(source)]).toEqual([file, false])
      expect([file, /ragu upgrade\{\/highlight\} to update/.test(source)]).toEqual([file, false])
    }
  })

  test("the help dialog does not call ragu upgrade a self-upgrade", () => {
    expect(read("tui/src/ui/dialog-help.tsx")).not.toContain("Self-upgrade")
  })

  test("ragu doctor does not send anyone to ragu upgrade to fix the PATH", () => {
    expect(read("ragu/src/doctor/checks.ts")).not.toMatch(/ragu upgrade.{0,3} with the same package manager/)
  })
})
