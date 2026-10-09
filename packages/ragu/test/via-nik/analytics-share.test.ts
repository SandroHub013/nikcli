import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package B (4): usage totals were sent every day to dashboard.nikcli-ai.dev, on by
 * default. The sending goes: the module, its start with the server and `ragu analytics publish`. The local
 * statistics stay (`ragu analytics show`, `ragu stats`).
 */
const SRC = path.join(import.meta.dir, "../../src")

describe("usage reporting to Nik's dashboard is gone", () => {
  test("no sending module, and the server does not start one", () => {
    expect(fs.existsSync(path.join(SRC, "analytics/share.ts"))).toBe(false)
    expect(fs.readFileSync(path.join(SRC, "server/server.ts"), "utf8")).not.toContain("AnalyticsShare")
  })

  test("`ragu analytics` keeps `show` and loses `publish`", async () => {
    const { Commands } = await import("@/cli/commands")
    const analytics = Commands.commands["analytics"] as unknown as { commands: Record<string, unknown> }
    expect(Object.keys(analytics.commands).sort()).toEqual(["show"])
  })
})
