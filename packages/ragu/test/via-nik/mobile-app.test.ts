import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package B: the mobile app (packages/mobile) still called what the server no longer
 * has: teleport (/mobile/session/:id/teleport, a saved target server) and published artifacts (a session's
 * `artifacts`, the artifact tool's links on nikcli-ai.dev). Both go from the app; LAN pairing stays.
 */
const MOBILE = path.join(import.meta.dir, "../../../mobile")
const exists = (file: string) => fs.existsSync(path.join(MOBILE, file))
const read = (file: string) => fs.readFileSync(path.join(MOBILE, file), "utf8")

function sources(dir: string): string[] {
  return fs
    .readdirSync(path.join(MOBILE, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
    .map((entry) => path.relative(MOBILE, path.join(entry.parentPath, entry.name)))
}

describe("the mobile app without teleport and published artifacts", () => {
  test("no teleport sheet, client call or saved target", () => {
    expect(exists("components/session/SessionTeleportSheet.tsx")).toBe(false)
    const hits = [...sources("app"), ...sources("components"), ...sources("lib")].filter((file) =>
      /teleport/i.test(read(file)),
    )
    expect(hits).toEqual([])
  })

  test("no published artifacts from the server or nikcli-ai.dev", () => {
    expect(read("lib/types.ts")).not.toMatch(/SessionArtifact|artifacts\?:/)
    expect(read("lib/session-artifacts.ts")).not.toMatch(/nikcli-ai\.dev|tool !== "artifact"|PublishedArtifact/)
    expect(read("components/session/SessionPreviewStrip.tsx")).not.toContain("nikcli-ai.dev")
  })

  test("LAN pairing is still there", () => {
    expect(read("lib/client.ts")).toMatch(/pair/i)
  })
})
