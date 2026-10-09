import { describe, expect, it } from "bun:test"
import fs from "fs"
import fsp from "fs/promises"
import os from "os"
import path from "path"
import { removeTestDir } from "../helpers/fs"

/*
 * Brief ragu-via-servizi-nik, package C, [modello]: the support assistant was told to cite
 * `https://nikcli-ai.dev/docs/...`, and the docs index the support dialog sends with each question told it to
 * `webfetch https://nikcli-ai.dev/docs`. Those are Nik's docs: the assistant cites the files it read, and the index
 * points at the local files and at `websearch`.
 */
describe("the support assistant is not sent to Nik's docs", () => {
  it("the support agent's prompt does not cite nikcli-ai.dev", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "../../src/agent/agent.ts"), "utf8")
    expect(source).not.toContain("nikcli-ai.dev")
  })

  it("the docs index of a folder without docs names no Nik host", async () => {
    const { buildSupportDocsIndex } = await import("@tui/util/support-docs")
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ragu-support-docs-"))
    try {
      const index = await buildSupportDocsIndex(root)
      expect(index).toContain("No documentation files found")
      expect(index).not.toContain("nikcli-ai.dev")
    } finally {
      await removeTestDir(root)
    }
  })

  it("the docs index of a folder with docs names no Nik host", async () => {
    const { buildSupportDocsIndex } = await import("@tui/util/support-docs")
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ragu-support-docs-"))
    try {
      await fsp.writeFile(path.join(root, "README.md"), "# readme\n")
      const index = await buildSupportDocsIndex(root)
      expect(index).toContain("README.md")
      expect(index).not.toContain("nikcli-ai.dev")
    } finally {
      await removeTestDir(root)
    }
  })
})
