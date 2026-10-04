import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as system from "../src/commands/system.ts"
import * as file from "../src/commands/file.ts"
import { collect } from "../src/commands/health.ts"
import type { CommandContext } from "../src/gadget.ts"

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    signal: new AbortController().signal,
    deadline: Date.now() + 5_000,
    maxOutputBytes: 1024,
    callID: "c",
    env: process.env,
    log: () => undefined,
    ...overrides,
  }
}

describe("system.run", () => {
  test("captures stdout and the exit code", async () => {
    const result = await system.run({ argv: ["sh", "-c", "echo hi; exit 3"] }, ctx())
    expect(result).toMatchObject({ output: "hi\n", exitCode: 3, isError: true })
  })

  test("feeds stdin and labels stderr", async () => {
    const result = await system.run({ argv: ["sh", "-c", "cat; echo err >&2"], stdin: "in" }, ctx())
    expect(typeof result === "string" ? result : result.output).toBe("in\n[stderr]\nerr\n")
  })

  test("a missing program is exit 127, not a throw", async () => {
    const result = await system.run({ argv: ["/definitely/not/here"] }, ctx())
    expect(result).toMatchObject({ exitCode: 127, isError: true })
  })

  test("aborts at the signal", async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const result = await system.run({ argv: ["sleep", "5"] }, ctx({ signal: controller.signal }))
    expect(result).toMatchObject({ exitCode: 124 })
  })
})

describe("file.read / file.write", () => {
  test("writes in chunks, replaces on final, reads back with offsets", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "nikcli-gadget-file-"))
    try {
      const target = path.join(dir, "out.txt")
      const write = file.write([dir])
      await write({ path: target, content: "hello ", final: false }, ctx())
      expect(await readFile(`${target}.nikcli-part`, "utf8")).toBe("hello ")
      const done = await write({ path: target, content: "world", append: true }, ctx())
      expect(JSON.parse((done as { output: string }).output)).toMatchObject({ size: 11, final: true })
      expect(await readFile(target, "utf8")).toBe("hello world")
      const read = file.read([dir])
      const first = JSON.parse(((await read({ path: target, length: 5 }, ctx())) as { output: string }).output)
      expect(first).toMatchObject({ content: "hello", next: 5, eof: false, size: 11 })
      const rest = JSON.parse(((await read({ path: target, offset: 5 }, ctx())) as { output: string }).output)
      expect(rest).toMatchObject({ content: " world", eof: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses paths outside the roots", async () => {
    const result = await file.read(["/nonexistent-root"])({ path: "/etc/hostname" }, ctx())
    expect(result).toMatchObject({ isError: true })
    expect((result as { output: string }).output).toMatch(/outside/)
  })
})

describe("device.health", () => {
  test("reports the fields the agent reads", async () => {
    const health = await collect()
    expect(health.uptimeSec).toBeGreaterThanOrEqual(0)
    expect(health.load).toHaveLength(3)
    expect(health.memory.totalBytes).toBeGreaterThan(0)
  })
})
