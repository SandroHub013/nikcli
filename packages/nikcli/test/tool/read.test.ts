import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { removeTestDir } from "../helpers/fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ReadTool } from "@/tool/read"
import { Instance } from "@/project/instance"
import { makeToolContext, withProjectDirectory } from "../helpers/tool-context"

describe("ReadTool", () => {
  let projectDir: string
  let def: Awaited<ReturnType<typeof ReadTool.init>>

  beforeAll(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-read-test-"))
    def = await withProjectDirectory(projectDir, () => ReadTool.init())
  })

  afterAll(async () => {
    await Instance.disposeAll().catch(() => undefined)
    const { Database } = await import("@/database/database")
    Database.closeAll()
    await removeTestDir(projectDir)
  })

  it("reads file contents and records a read permission ask", async () => {
    const filePath = path.join(projectDir, "hello.txt")
    await fs.writeFile(filePath, "line1\nline2\n")
    const { ctx, asked } = makeToolContext()
    const result = await withProjectDirectory(projectDir, () => def.executeAsync({ filePath }, ctx))
    expect(result.output).toContain("line1")
    expect(result.output).toContain("line2")
    expect(asked.some((a) => a.permission === "read")).toBe(true)
  })

  it("resolves a relative path against the instance, not the process cwd", async () => {
    // The background service runs every project from one process, so its
    // cwd belongs to none of them.
    await fs.writeFile(path.join(projectDir, "relative.txt"), "from the instance\n")
    expect(process.cwd()).not.toBe(projectDir)
    const { ctx } = makeToolContext()
    const result = await withProjectDirectory(projectDir, () => def.executeAsync({ filePath: "relative.txt" }, ctx))
    expect(result.output).toContain("from the instance")
  })

  it("respects offset and limit", async () => {
    const filePath = path.join(projectDir, "numbered.txt")
    await fs.writeFile(filePath, "a\nb\nc\nd\ne\n")
    const { ctx } = makeToolContext()
    const result = await withProjectDirectory(projectDir, () =>
      def.executeAsync({ filePath, offset: 2, limit: 2 }, ctx),
    )
    expect(result.output).toContain("b")
    expect(result.output).toContain("c")
    expect(result.output).not.toMatch(/^\d+: a$/m)
    expect(result.output).not.toMatch(/^\d+: e$/m)
    expect(result.output).toContain("2: b")
    expect(result.output).toContain("3: c")
  })

  it("lists directories with stable paging", async () => {
    const directory = path.join(projectDir, "listing")
    await fs.mkdir(path.join(directory, "nested"), { recursive: true })
    await fs.writeFile(path.join(directory, "alpha.txt"), "alpha")
    await fs.writeFile(path.join(directory, "beta.txt"), "beta")
    const { ctx } = makeToolContext()

    const first = await withProjectDirectory(projectDir, () => def.executeAsync({ filePath: directory, limit: 2 }, ctx))
    expect(first.output).toContain("entries 1-2")
    expect(first.output).toContain(`nested${path.sep}`)
    expect(first.output).toContain("alpha.txt")
    expect(first.output).toContain("Continue reading with offset: 3")
    expect(first.metadata.truncated).toBe(true)

    const second = await withProjectDirectory(projectDir, () =>
      def.executeAsync({ filePath: directory, offset: 3, limit: 2 }, ctx),
    )
    expect(second.output).toContain("beta.txt")
    expect(second.metadata.truncated).toBe(false)
  })

  it("bounds directory output by bytes", async () => {
    const directory = path.join(projectDir, "large-listing")
    await fs.mkdir(directory)
    await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        fs.writeFile(path.join(directory, `${String(index).padStart(3, "0")}-${"x".repeat(180)}.txt`), ""),
      ),
    )
    const { ctx } = makeToolContext()

    const result = await withProjectDirectory(projectDir, () => def.executeAsync({ filePath: directory }, ctx))
    expect(Buffer.byteLength(result.output, "utf-8")).toBeLessThanOrEqual(50 * 1024)
    expect(result.output).toContain("Continue reading with offset:")
    expect(result.metadata.truncated).toBe(true)
  })

  it("rejects oversized media before ingestion", async () => {
    const filePath = path.join(projectDir, "oversized.png")
    await fs.writeFile(filePath, "")
    await fs.truncate(filePath, 20 * 1024 * 1024 + 1)
    const { ctx } = makeToolContext()

    await expect(withProjectDirectory(projectDir, () => def.executeAsync({ filePath }, ctx))).rejects.toThrow(
      /Media exceeds 20971520 byte ingestion limit/,
    )
  })

  it("bounds long lines while continuing to later lines", async () => {
    const filePath = path.join(projectDir, "long-line.txt")
    await fs.writeFile(filePath, `${"x".repeat(10_000)}\nsecond\n`)
    const { ctx } = makeToolContext()

    const result = await withProjectDirectory(projectDir, () => def.executeAsync({ filePath }, ctx))
    expect(result.output).toContain(`1: ${"x".repeat(2_000)}...`)
    expect(result.output).toContain("2: second")
    expect(result.output).not.toContain("x".repeat(2_001))
  })

  it("rejects offset less than 1", async () => {
    const filePath = path.join(projectDir, "x.txt")
    await fs.writeFile(filePath, "x\n")
    const { ctx } = makeToolContext()
    await expect(
      withProjectDirectory(projectDir, () => def.executeAsync({ filePath, offset: 0 }, ctx)),
    ).rejects.toThrow(/offset must be/)
  })

  it("rejects fractional pagination values", async () => {
    const filePath = path.join(projectDir, "fractional.txt")
    await fs.writeFile(filePath, "one\ntwo\n")
    const { ctx } = makeToolContext()

    await expect(
      withProjectDirectory(projectDir, () => def.executeAsync({ filePath, offset: 1.5 }, ctx)),
    ).rejects.toThrow(/offset must be a positive integer/)
    await expect(
      withProjectDirectory(projectDir, () => def.executeAsync({ filePath, limit: 0.5 }, ctx)),
    ).rejects.toThrow(/limit must be a positive integer/)
  })

  it("throws File not found for missing paths", async () => {
    const filePath = path.join(projectDir, "missing-unique-xyz.txt")
    const { ctx } = makeToolContext()
    await expect(withProjectDirectory(projectDir, () => def.executeAsync({ filePath }, ctx))).rejects.toThrow(
      /File not found/,
    )
  })

  it("reports the requested path when its parent directory is missing too", async () => {
    const filePath = path.join(projectDir, "no-such-dir", "nested", "file.txt")
    const { ctx } = makeToolContext()
    // Listing the parent for "did you mean" suggestions must not surface its own
    // ENOENT — the model asked about the file, not the directory.
    await expect(withProjectDirectory(projectDir, () => def.executeAsync({ filePath }, ctx))).rejects.toThrow(
      `File not found: ${filePath}`,
    )
  })
})

describe("ReadTool missing-file suggestions", () => {
  let dir: string
  let def: Awaited<ReturnType<typeof ReadTool.init>>

  async function gitInit(target: string) {
    const proc = Bun.spawn(["git", "init", "--quiet"], {
      cwd: target,
      stdout: "pipe",
      stderr: "pipe",
    })
    const code = await proc.exited
    if (code !== 0) {
      throw new Error(`git init failed in ${target}: ${await new Response(proc.stderr).text()}`)
    }
  }

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-read-suggest-"))
    // A real repository, so the instance worktree is this directory — which is
    // the tree the suggestions search, exactly as it behaves in production.
    await gitInit(dir)
    def = await withProjectDirectory(dir, () => ReadTool.init())
  })

  afterAll(async () => {
    await Instance.disposeAll().catch(() => undefined)
    const { Database } = await import("@/database/database")
    Database.closeAll()
    await removeTestDir(dir)
  })

  async function failure(filePath: string): Promise<string> {
    const { ctx } = makeToolContext()
    try {
      await withProjectDirectory(dir, () => def.executeAsync({ filePath }, ctx))
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    throw new Error(`expected ${filePath} to fail`)
  }

  it("suggests the same basename living in another folder", async () => {
    await fs.mkdir(path.join(dir, "src", "tool"), { recursive: true })
    await fs.mkdir(path.join(dir, "guess"), { recursive: true })
    await fs.writeFile(path.join(dir, "src", "tool", "read.ts"), "export const read = 1\n")

    const message = await failure(path.join(dir, "guess", "read.ts"))
    expect(message).toContain("Did you mean: src/tool/read.ts?")

    // Same guess, but the folder itself is a hallucination, so the sibling
    // listing cannot run at all — the project search is the only source.
    const missingDir = await failure(path.join(dir, "tool", "read.ts"))
    expect(missingDir).toContain("Did you mean: src/tool/read.ts?")
  })

  it("suggests a file that is one letter off", async () => {
    await fs.writeFile(path.join(dir, "parser.ts"), "export const parse = 1\n")

    const message = await failure(path.join(dir, "paresr.ts"))
    expect(message).toContain("Did you mean: parser.ts?")
  })

  it("keeps the plain message when nothing is close", async () => {
    const message = await failure(path.join(dir, "zzqqx-totally-unrelated-4711.bin"))
    expect(message).toBe(`File not found: ${path.join(dir, "zzqqx-totally-unrelated-4711.bin")}`)
    expect(message).not.toContain("Did you mean")
  })

  it("ignores files excluded by .gitignore", async () => {
    await fs.mkdir(path.join(dir, "generated"), { recursive: true })
    await fs.writeFile(path.join(dir, "generated", "widget.ts"), "export const widget = 1\n")
    await fs.writeFile(path.join(dir, ".gitignore"), "generated/\n")

    const message = await failure(path.join(dir, "widgte.ts"))
    expect(message).not.toContain("Did you mean")
  })

  it("stays bounded on a large tree", async () => {
    const big = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-read-big-"))
    try {
      await gitInit(big)
      const shards = Array.from({ length: 40 }, (_, index) => `shard-${String(index).padStart(2, "0")}`)
      await Promise.all(
        shards.map((shard) =>
          fs
            .mkdir(path.join(big, shard), { recursive: true })
            .then(() =>
              Promise.all(
                Array.from({ length: 200 }, (_, index) =>
                  fs.writeFile(path.join(big, shard, `file-${String(index).padStart(3, "0")}.ts`), ""),
                ),
              ),
            ),
        ),
      )

      const { ctx } = makeToolContext()
      const started = performance.now()
      let message = ""
      try {
        await withProjectDirectory(big, () => def.executeAsync({ filePath: path.join(big, "nope-9f3a.ts") }, ctx))
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      const elapsed = performance.now() - started

      expect(message).toContain("File not found")
      // 8k files: an unbounded walk would enumerate all of them. The scan caps
      // itself at 4k files / 120 ms, so this stays far under a second even on a
      // cold Windows filesystem.
      expect(elapsed).toBeLessThan(1000)
    } finally {
      await removeTestDir(big)
    }
  })
})
