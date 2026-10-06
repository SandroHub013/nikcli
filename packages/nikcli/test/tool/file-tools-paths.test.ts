import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ReadTool } from "@/tool/read"
import { WriteTool } from "@/tool/write"
import { ApplyPatchTool } from "@/tool/apply_patch"
import { Instance } from "@/project/instance"
import { makeToolContext, withProjectDirectory } from "../helpers/tool-context"

// What a model copies out of a shell, in the dialects it meets on Windows.
function msys(p: string) {
  return "/" + p.replace(/^([a-zA-Z]):/, (_, d: string) => d.toLowerCase()).replaceAll("\\", "/")
}
function fileUrl(p: string) {
  return "/" + p.replaceAll("\\", "/")
}

describe("file tools read a path the same way", () => {
  let projectDir: string

  beforeAll(async () => {
    projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-paths-")))
    await fs.mkdir(path.join(projectDir, "zzsrc"), { recursive: true })
    await fs.writeFile(path.join(projectDir, "zzsrc", "a.txt"), "alpha\n")
  })

  afterAll(async () => {
    await Instance.disposeAll().catch(() => undefined)
    await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {})
  })

  const target = () => path.join(projectDir, "zzsrc", "a.txt")

  it("read takes /c/x and /C:/x for the file C:\\x (Windows only)", async () => {
    if (process.platform !== "win32") return
    const def = await withProjectDirectory(projectDir, () => ReadTool.init())
    for (const form of [msys(target()), fileUrl(target())]) {
      const { ctx } = makeToolContext()
      const result = await withProjectDirectory(projectDir, () => def.executeAsync({ filePath: form }, ctx))
      expect(result.output).toContain("alpha")
    }
  })

  it("read takes /zzsrc/a.txt for the project's zzsrc/a.txt", async () => {
    const def = await withProjectDirectory(projectDir, () => ReadTool.init())
    const { ctx } = makeToolContext()
    const result = await withProjectDirectory(projectDir, () => def.executeAsync({ filePath: "/zzsrc/a.txt" }, ctx))
    expect(result.output).toContain("alpha")
  })

  it("write puts /zzsrc/b.txt in the project, not at the root of the disk", async () => {
    const def = await withProjectDirectory(projectDir, () => WriteTool.init())
    const { ctx } = makeToolContext()
    await withProjectDirectory(projectDir, () => def.executeAsync({ filePath: "/zzsrc/b.txt", content: "bravo\n" }, ctx))
    expect(await fs.readFile(path.join(projectDir, "zzsrc", "b.txt"), "utf8")).toBe("bravo\n")
  })

  it("apply_patch updates /zzsrc/a.txt in the project", async () => {
    const def = await withProjectDirectory(projectDir, () => ApplyPatchTool.init())
    const { ctx } = makeToolContext()
    await withProjectDirectory(projectDir, () =>
      def.executeAsync(
        { patchText: "*** Begin Patch\n*** Update File: /zzsrc/a.txt\n@@\n-alpha\n+alpha2\n*** End Patch" },
        ctx,
      ),
    )
    expect(await fs.readFile(target(), "utf8")).toBe("alpha2\n")
  })

  it("apply_patch with a blank line and a numbered header in the hunk still applies", async () => {
    await fs.writeFile(path.join(projectDir, "zzsrc", "c.txt"), "one\n\ntwo\nthree\n")
    const def = await withProjectDirectory(projectDir, () => ApplyPatchTool.init())
    const { ctx } = makeToolContext()
    await withProjectDirectory(projectDir, () =>
      def.executeAsync(
        {
          patchText:
            "*** Begin Patch\n*** Update File: zzsrc/c.txt\n@@ -1,4 +1,4 @@\n one\n\n-two\n+TWO\n three\n*** End Patch",
        },
        ctx,
      ),
    )
    expect(await fs.readFile(path.join(projectDir, "zzsrc", "c.txt"), "utf8")).toBe("one\n\nTWO\nthree\n")
  })

  it("apply_patch that does not match tells what the file reads now", async () => {
    const def = await withProjectDirectory(projectDir, () => ApplyPatchTool.init())
    const { ctx } = makeToolContext()
    const failure = await withProjectDirectory(projectDir, () =>
      def
        .executeAsync(
          { patchText: "*** Begin Patch\n*** Update File: zzsrc/c.txt\n@@\n one\n-twoo\n+x\n*** End Patch" },
          ctx,
        )
        .then(() => "", (error) => String(error)),
    )
    expect(failure).toContain("apply_patch verification failed")
    expect(failure).toContain("Closest match")
    expect(failure).toContain("The file now reads:")
  })
})
