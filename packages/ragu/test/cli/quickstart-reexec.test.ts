import { describe, expect, test } from "bun:test"
import { reexecCommand } from "@/cli/handlers/quickstart"

/*
 * Review of the CLI, P0 1: `ragu quickstart` handed off to the next step by running itself again with `quickstart` still in
 * its argv (`ragu quickstart auth login`), and in the compiled binary with the internal `/$bunfs/…` entry added, which
 * the parser took for `--project`. The next step is what runs, and nothing of the way quickstart was called.
 */
describe("quickstart hands off to the next step", () => {
  const compiled = { execPath: "C:/Users/me/.ragu/bin/ragu.exe", entry: "/$bunfs/root/ragu.exe", standalone: true }
  const source = { execPath: "C:/bun/bun.exe", entry: "C:/src/ragu/src/index.ts", standalone: false }

  test("the compiled binary is its own interpreter: its argv is only the new arguments", () => {
    expect(reexecCommand(["auth", "login"], compiled)).toEqual(["C:/Users/me/.ragu/bin/ragu.exe", "auth", "login"])
    expect(reexecCommand([], compiled)).toEqual(["C:/Users/me/.ragu/bin/ragu.exe"])
  })

  test("from source bun gets the entry, then only the new arguments", () => {
    expect(reexecCommand(["run", "say hi"], source)).toEqual(["C:/bun/bun.exe", "C:/src/ragu/src/index.ts", "run", "say hi"])
  })

  test("`quickstart` and its own flags never reach the child: the way it was called is not read at all", () => {
    const before = process.argv
    process.argv = [before[0]!, before[1]!, "quickstart", "--skip-checks", "--dry-run"]
    try {
      expect(reexecCommand(["models"], compiled)).toEqual(["C:/Users/me/.ragu/bin/ragu.exe", "models"])
    } finally {
      process.argv = before
    }
  })

  test("from source without an entry there is nothing to run: it says so", () => {
    expect(() => reexecCommand(["models"], { ...source, entry: undefined })).toThrow("entrypoint")
  })
})
