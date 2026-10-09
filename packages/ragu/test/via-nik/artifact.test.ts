import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package B (1): artifacts were published to nikcli.store, Nik's server, without
 * asking. The tool was already out of the registry; the rest goes too: the module, `ragu artifact`, the mobile
 * session's list and the TUI card. Nothing keeps a local copy: ADE never used it.
 */
const SRC = path.join(import.meta.dir, "../../src")
const TUI = path.join(import.meta.dir, "../../../tui/src")

function sources(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
}

describe("artifacts are gone", () => {
  test("no `ragu artifact` command", async () => {
    const { Commands } = await import("@/cli/commands")
    expect(Object.keys(Commands.commands)).not.toContain("artifact")
  })

  test("no artifact module, tool or handler in the sources", () => {
    for (const file of ["artifact/index.ts", "artifact/repo.ts", "tool/artifact.ts", "tool/artifact.txt", "cli/handlers/artifact"])
      expect([file, fs.existsSync(path.join(SRC, file))]).toEqual([file, false])
  })

  test("nothing imports it, and neither the mobile session nor the TUI shows one", () => {
    const hits = [...sources(SRC), ...sources(TUI)].flatMap((file) =>
      fs
        .readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, at: `${path.relative(path.join(SRC, "../.."), file)}:${i + 1}` }))
        .filter(({ line }) => /@\/artifact\b|tool\/artifact|MobileArtifact|ArtifactView|artifactPublishedHref/.test(line))
        .map(({ at }) => at),
    )
    expect(hits).toEqual([])
  })
})
