import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { guardNikFetch } from "../helpers/no-nik-fetch"

/*
 * Brief ragu-via-servizi-nik, package B (2): sharing published a session on Nik's share service (s.nikcli-ai.dev,
 * links nikcli-ai.dev/s/<id>). The local mode only existed as its fallback, and without the service the terminal had
 * no address to give, so the whole feature goes: /share and /unshare in the TUI and the web app, `run --share`,
 * `run --session <share link>`, `ragu import <share link>`, the import from a PR body in `ragu pr`, the server's
 * share and unshare endpoints and the /s, /share and /api/share pages, the RAGU_AUTO_SHARE and RAGU_DISABLE_SHARE
 * switches, and the `share` and `autoshare` config keys (accepted and ignored). The tables and their migration stay;
 * `Session.Info.share` stays in the contract for old sessions but is no longer written. `ragu remote share` stays:
 * it prints the LAN link of the mobile remote.
 */
const PACKAGES = path.join(import.meta.dir, "../../..")
const read = (file: string) => fs.readFileSync(path.join(PACKAGES, file), "utf8")
const exists = (file: string) => fs.existsSync(path.join(PACKAGES, file))

describe("sharing is gone", () => {
  test("no share client and no share service", () => {
    expect(exists("ragu/src/share/share-next.ts")).toBe(false)
    expect(read("ragu/src/project/bootstrap.ts")).not.toContain("share")
  })

  test("the server has no share endpoints and serves no share pages", async () => {
    const guard = guardNikFetch()
    try {
      const { Server } = await import("@/server/server")
      for (const [method, url] of [
        ["GET", "/s/abc"],
        ["GET", "/share/abc"],
        ["GET", "/api/share/abc"],
        ["GET", "/api/share/abc/data"],
      ] as const) {
        const response = await Server.fetch(new Request(`http://localhost${url}`, { method }))
        expect([url, response.status]).toEqual([url, 404])
      }
      expect(read("ragu/src/server/httpapi/session.ts")).not.toMatch(/"\/:sessionID\/share"/)
      expect(guard.attempts).toEqual([])
    } finally {
      guard.restore()
    }
  })

  test("no CLI way in: `run --share`, share links in `run --session`, `import` and `pr`", () => {
    expect(read("ragu/src/cli/commands.ts")).not.toContain('Flag.boolean("share")')
    expect(read("ragu/src/cli/handlers/run.ts")).not.toMatch(/ShareNext|session\.share|ShareReference|SHARE_ID|share URL/)
    expect(read("ragu/src/cli/handlers/import.ts")).not.toMatch(/share|fetch\(/i)
    expect(read("ragu/src/cli/handlers/pr.ts")).not.toMatch(/\/s\/|import"/)
    expect(read("util/src/flag.ts")).not.toMatch(/RAGU_AUTO_SHARE|RAGU_DISABLE_SHARE/)
  })

  test("no /share or /unshare in the TUI and the web app", () => {
    expect(read("tui/src/routes/session/index.tsx")).not.toMatch(/session\.(un)?share/)
    expect(read("tui/src/component/tips.tsx")).not.toMatch(/share/)
    expect(read("app/src/pages/session/use-session-commands.tsx")).not.toMatch(/session\.(un)?share/)
    expect(read("app/src/components/session/session-header.tsx")).not.toMatch(/\.(un)?share\(/)
  })

  test("`ragu remote share` (the mobile remote's LAN link) is still there", async () => {
    const { Commands } = await import("@/cli/commands")
    const remote = Commands.commands["remote"] as unknown as { commands: Record<string, unknown> }
    expect(Object.keys(remote.commands)).toContain("share")
  })
})
