import { Effect } from "effect"
import { z } from "zod"
import { preserveTestEnv } from "../helpers/env"
import { afterAll, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "node:path"
import { removeTestDir } from "../helpers/fs"

/**
 * A new session used to cost the whole cache prefix twice: the bash tool's schema named the working
 * directory, so it was the one tool in the list that differed between sessions, and the `<env>`
 * block sat in the system prompt, cutting the prefix again. These tests pin the two properties the
 * fix rests on — the static half is byte-identical across sessions, and the session-specific half
 * is delivered once, ahead of the conversation, unchanged for the rest of the session.
 */

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-system-prefix-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
process.env.XDG_DATA_HOME = path.join(testHome, "data")
process.env.XDG_CACHE_HOME = path.join(testHome, "cache")
process.env.XDG_CONFIG_HOME = path.join(testHome, "config")
process.env.XDG_STATE_HOME = path.join(testHome, "state")

preserveTestEnv([
  "NIKCLI_TEST_HOME",
  "NIKCLI_DISABLE_PROJECT_CONFIG",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
])

const { SystemPrompt } = await import("@/session/system")
const { InstructionSync } = await import("@/session/instruction-sync")
const { BashTool } = await import("@/tool/bash")
const { Instance } = await import("@/project/instance")
const { runPromiseWithLayer, withCurrentInstance } = await import("@/effect")

const dirs: string[] = []

async function makeProject(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-system-prefix-project-")))
  dirs.push(dir)
  return dir
}

const runIn = <A, E>(directory: string, effect: Effect.Effect<A, E, any>) =>
  Instance.provide({ directory, fn: () => runPromiseWithLayer(SystemPrompt.defaultLayer, withCurrentInstance(effect)) })

const staticBlock = (directory: string) =>
  runIn(
    directory,
    Effect.gen(function* () {
      const service = yield* SystemPrompt.Service
      return yield* service.environmentStatic()
    }),
  )

const sessionBlock = (directory: string) =>
  runIn(
    directory,
    Effect.gen(function* () {
      const service = yield* SystemPrompt.Service
      return yield* service.environmentSession()
    }),
  )

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
  await removeTestDir(testHome)
})

describe("the static half of the prompt", () => {
  it("is byte-identical for two sessions in different directories", async () => {
    const a = await makeProject()
    const b = await makeProject()
    expect(await staticBlock(a)).toEqual(await staticBlock(b))
  })

  it("carries no directory, date or package manager", async () => {
    const a = await makeProject()
    const b = await makeProject()
    const block = (await staticBlock(a)).join("\n")
    expect(block).not.toContain(a)
    expect(block).not.toContain(b)
    // The process policy still has to be there, or the monitor/bash rules are gone.
    expect(block).toContain("Use the monitor tool, not bash")
    expect(block).toContain("<command_execution>")
  })

  it("names no working directory in the bash tool, so its schema is stable too", async () => {
    const a = await makeProject()
    const b = await makeProject()
    // The string the model reads is the JSON schema, not the Effect Schema tree: that is what
    // carries the parameter descriptions, and it is what sits in the cached prefix.
    const wire = async (directory: string) => {
      const def = await Instance.provide({ directory, fn: () => BashTool.init() })
      const schema = z.toJSONSchema(def.parameters as unknown as z.ZodType, { io: "input", unrepresentable: "any" })
      return JSON.stringify({ description: def.description, input: schema })
    }
    const first = await wire(a)
    const second = await wire(b)
    expect(second).toBe(first)
    expect(first).not.toContain(a)
    expect(first).not.toContain(b)
    // Both halves of the tool used to name the directory; now they point at the session block.
    expect(first).toContain("<env>")
    expect(first).toContain("workdir")
  })
})

describe("the session-specific half", () => {
  it("does differ between two directories, so nothing was lost", async () => {
    const a = await makeProject()
    const b = await makeProject()
    const first = (await sessionBlock(a)).join("\n")
    const second = (await sessionBlock(b)).join("\n")
    expect(first).not.toEqual(second)
    expect(first).toContain(a)
    expect(second).toContain(b)
    expect(first).toContain("<env>")
  })

  it("is the same on every call inside a session, so the prefix never moves mid-session", async () => {
    const dir = await makeProject()
    expect(await sessionBlock(dir)).toEqual(await sessionBlock(dir))
  })

  it("is kept out of the system prompt and carried as a session message instead", async () => {
    const dir = await makeProject()
    const reads = [
      {
        key: "env",
        status: "value" as const,
        body: { kind: "env" as const, parts: await staticBlock(dir) },
      },
      {
        key: "env-session",
        status: "value" as const,
        body: { kind: "env-session" as const, parts: await sessionBlock(dir) },
      },
    ]
    const rendered = InstructionSync.renderLive(reads)
    // Static half in the system prompt, session half ahead of the conversation.
    expect(rendered.system.join("\n")).not.toContain(dir)
    expect(rendered.sessionMessages.join("\n")).toContain(dir)
    expect(rendered.sessionMessages.join("\n")).toContain("<env>")
    // Both halves together are what the model used to get in one system prompt.
    expect([...rendered.system, ...rendered.sessionMessages].join("\n")).toContain(dir)
  })
})
