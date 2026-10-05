import { Effect } from "effect"
import { preserveTestEnv } from "../helpers/env"
import { afterAll, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "node:path"
import { removeTestDir } from "../helpers/fs"
import { runPromiseWithLayer, withCurrentInstance } from "../../src/effect"
import type { MessageV2 } from "@/session/message-v2"
import type { Session } from "@/session"

/**
 * `nikcli run` cost two model calls per run, both only to name things nobody reads: the session
 * (`PromptTitle.ensure`) and the user message (`SessionSummary`). A session carrying the `question`
 * deny that `run` puts on it takes both titles from the prompt text. Every other session keeps
 * model-written titles.
 */

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-headless-title-home-"))
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

const { Identifier } = await import("@nikcli-ai/util/id")
const { MessageV2: Message } = await import("@/session/message-v2")
const { SessionV2 } = await import("@/session/v2")
const { SessionSummary } = await import("@/session/summary")
const { PromptTitle } = await import("@/session/prompt-title")
const { HeadlessTitle } = await import("@/session/headless-title")
const { Instance } = await import("@/project/instance")
const { HEADLESS_PERMISSION } = await import("@/cli/handlers/run")

const projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-headless-title-project-")))
afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  await fs.rm(projectDir, { recursive: true, force: true })
  await removeTestDir(testHome)
})

const PROMPT = "  Fix the failing   cross-module import\n\nThe grader says foo() is undefined after the refactor."
const DERIVED = "Fix the failing cross-module import"

function persistUser(sessionID: string, text = PROMPT) {
  const info = {
    id: Identifier.ascending("message"),
    sessionID,
    role: "user" as const,
    time: { created: 1 },
    agent: "build",
    model: { providerID: "p", modelID: "m" },
  }
  SessionV2.persist({
    prepared: {
      info: info as never,
      parts: [{ id: Identifier.ascending("part"), sessionID, messageID: info.id, type: "text" as const, text }],
    },
    promptData: JSON.stringify({ sessionID, parts: [{ type: "text", text }] }),
    projectID: Instance.project.id,
  })
  return info
}

async function messages(sessionID: string) {
  const all: MessageV2.WithParts[] = []
  for await (const msg of Message.stream(sessionID)) all.push(msg)
  return all
}

describe("HeadlessTitle.fromPrompt", () => {
  it("takes the first non-empty line with whitespace collapsed", () => {
    expect(HeadlessTitle.fromPrompt(PROMPT)).toBe(DERIVED)
    expect(HeadlessTitle.fromPrompt("\r\n\t \r\nhello   world\r\nsecond")).toBe("hello world")
  })

  it("cuts a long line on a word boundary", () => {
    const title = HeadlessTitle.fromPrompt("word ".repeat(40))!
    expect(title.length).toBeLessThanOrEqual(72)
    expect(title.endsWith("...")).toBe(true)
    expect(title.slice(0, -3).endsWith("word")).toBe(true)
  })

  it("hard-cuts a line with no usable space", () => {
    const title = HeadlessTitle.fromPrompt("x".repeat(200))!
    expect(title).toBe("x".repeat(69) + "...")
  })

  it("has nothing to say about empty text", () => {
    expect(HeadlessTitle.fromPrompt("")).toBeUndefined()
    expect(HeadlessTitle.fromPrompt(" \n\t\n ")).toBeUndefined()
  })
})

describe("HeadlessTitle.isHeadless", () => {
  it("is what `run` puts on its sessions, and nothing else", () => {
    expect(HeadlessTitle.isHeadless({ permission: HEADLESS_PERMISSION })).toBe(true)
    expect(HeadlessTitle.isHeadless({ permission: undefined })).toBe(false)
    expect(HeadlessTitle.isHeadless({ permission: [] })).toBe(false)
    expect(
      HeadlessTitle.isHeadless({ permission: [{ permission: "question", action: "deny", pattern: "secret/*" }] }),
    ).toBe(false)
  })
})

describe("PromptTitle.ensure", () => {
  const modelPath = new Error("reached the title model")
  function fakeDeps() {
    const calls = { agentGet: 0, model: 0 }
    const titles: string[] = []
    const deps: import("@/session/prompt-title").PromptTitle.Deps = {
      async agentGet() {
        calls.agentGet++
        return { name: "title", model: { providerID: "p", modelID: "m" } } as never
      },
      async providerGetModel() {
        calls.model++
        throw modelPath
      },
      async providerGetSmallModel() {
        calls.model++
        throw modelPath
      },
      async sessionUpdate(_id, editor) {
        const draft = { title: "New session - 2026-09-30T00:00:00.000Z" } as Session.Info
        editor(draft)
        titles.push(draft.title)
        return draft
      },
    }
    return { deps, calls, titles }
  }
  function input(session: Session.Info, history: MessageV2.WithParts[]) {
    return { session, history, providerID: "p", modelID: "m" }
  }

  it("titles a run session from the prompt without touching the model", async () => {
    await Instance.provide({
      directory: projectDir,
      fn: async () => {
        const session = await SessionV2.create({ permission: HEADLESS_PERMISSION as never })
        persistUser(session.id)
        const { deps, calls, titles } = fakeDeps()
        await PromptTitle.ensure(deps, input(session, await messages(session.id)))
        expect(calls).toEqual({ agentGet: 0, model: 0 })
        expect(titles).toEqual([DERIVED])
      },
    })
  })

  it("leaves a title given with --title alone", async () => {
    await Instance.provide({
      directory: projectDir,
      fn: async () => {
        const session = await SessionV2.create({ title: "my own title", permission: HEADLESS_PERMISSION as never })
        persistUser(session.id)
        const { deps, calls, titles } = fakeDeps()
        await PromptTitle.ensure(deps, input(session, await messages(session.id)))
        expect(calls).toEqual({ agentGet: 0, model: 0 })
        expect(titles).toEqual([])
      },
    })
  })

  it("still goes to the model in an interactive session", async () => {
    await Instance.provide({
      directory: projectDir,
      fn: async () => {
        const session = await SessionV2.create({})
        persistUser(session.id)
        const { deps, calls, titles } = fakeDeps()
        await expect(PromptTitle.ensure(deps, input(session, await messages(session.id)))).rejects.toBe(modelPath)
        expect(calls.agentGet).toBe(1)
        expect(calls.model).toBe(1)
        expect(titles).toEqual([])
      },
    })
  })
})

describe("SessionSummary.summarize", () => {
  function summarize(sessionID: string, messageID: string) {
    return runPromiseWithLayer(
      SessionSummary.runnerLayer,
      withCurrentInstance(
        Effect.gen(function* () {
          const summary = yield* SessionSummary.Service
          yield* summary.summarize({ sessionID, messageID })
        }),
      ),
    )
  }
  async function messageTitle(sessionID: string, messageID: string) {
    const found = (await messages(sessionID)).find((m) => m.info.id === messageID)
    return (found?.info as { summary?: { title?: string } } | undefined)?.summary?.title
  }

  it("titles the user message of a run session from the prompt, with no model call", async () => {
    await Instance.provide({
      directory: projectDir,
      fn: async () => {
        const session = await SessionV2.create({ permission: HEADLESS_PERMISSION as never })
        const info = persistUser(session.id)
        // The message's model is `p/m`, which does not exist: a model call would fail here.
        await summarize(session.id, info.id)
        expect(await messageTitle(session.id, info.id)).toBe(DERIVED)
      },
    })
  })

  it("does not derive the message title from the prompt in an interactive session", async () => {
    await Instance.provide({
      directory: projectDir,
      fn: async () => {
        const session = await SessionV2.create({})
        const info = persistUser(session.id)
        // It goes for the model (`p/m` is unknown, so the call fails); either way no derived title.
        await summarize(session.id, info.id).catch(() => undefined)
        expect(await messageTitle(session.id, info.id)).not.toBe(DERIVED)
      },
    })
  })
})
