import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * Review of the UI, N18: «ragu upgrade — Where new versions come from» did not say what the command does. It prints a
 * notice (offline) that Ragu Code does not update itself, and how to get a newer build.
 */
const read = (file: string) => readFileSync(join(import.meta.dir, "../../..", file), "utf8")

describe("what `ragu upgrade` is said to do", () => {
  test("the help, the tips and the CLI's own description all say it shows how to get a newer build", () => {
    expect(read("tui/src/ui/dialog-help.tsx")).toContain("How to get a newer build (Ragu Code does not update itself)")
    expect(read("tui/src/component/tips.tsx")).toContain("to see how to get a newer build")
    expect(read("tui/src/feature-plugins/home/tips-view.tsx")).toContain("to see how to get a newer build")
    expect(read("ragu/src/cli/commands.ts")).toContain('description: "show how to get a newer build (Ragu Code does not update itself)"')
  })

  test("none of them is the old, empty promise", () => {
    for (const file of ["tui/src/ui/dialog-help.tsx", "tui/src/component/tips.tsx", "tui/src/feature-plugins/home/tips-view.tsx", "ragu/src/cli/commands.ts"]) {
      expect(read(file)).not.toMatch(/where (new versions|Ragu Code updates) come from/i)
    }
  })

  test("and the command does print that notice", () => {
    expect(read("ragu/src/cli/handlers/upgrade.ts")).toContain("Ragu Code does not update itself.")
  })
})
