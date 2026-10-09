import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package B (2): teleport sent a session and its workspace to a remote server (a
 * Railway deploy). Gone: `ragu teleport`, the TUI's /teleport and its mode in the mobile dialog, the server's
 * teleport routes, the workspace archive upload and the `teleport` config key (accepted and ignored). Local
 * mobile pairing stays: it never leaves the LAN or the URL the user gives.
 */
const ROOT = path.join(import.meta.dir, "../../..")

function lines(dir: string, pattern: RegExp) {
  return fs
    .readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
    .flatMap((entry) => {
      const file = path.join(entry.parentPath, entry.name)
      return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) => (pattern.test(line) ? [`${path.relative(ROOT, file)}:${i + 1}`] : []))
    })
}

describe("teleport is gone", () => {
  test("no `ragu teleport` command", async () => {
    const { Commands } = await import("@/cli/commands")
    expect(Object.keys(Commands.commands)).not.toContain("teleport")
  })

  test("no teleport handler, server module or workspace archive", () => {
    for (const file of ["ragu/src/cli/handlers/teleport.ts", "ragu/src/server/mobile/teleport.ts", "util/src/teleport-archive.ts"])
      expect([file, fs.existsSync(path.join(ROOT, file))]).toEqual([file, false])
  })

  test("no route, TUI command or dialog mode for it", () => {
    expect(lines("ragu/src/server", /teleport/i)).toEqual([])
    expect(lines("tui/src/component", /teleport/i)).toEqual([])
  })

  test("mobile pairing is still there", async () => {
    const { Commands } = await import("@/cli/commands")
    const mobile = Commands.commands["mobile"] as unknown as { commands: Record<string, unknown> }
    expect(Object.keys(mobile.commands)).toContain("pair")
  })
})
