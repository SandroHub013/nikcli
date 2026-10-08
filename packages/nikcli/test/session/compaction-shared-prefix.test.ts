import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { AnthropicMessages } from "@nikcli-ai/llm/protocols"
import { Runtime } from "@nikcli-ai/llm"
import { Log } from "@nikcli-ai/util/log"

/**
 * The compaction that shares the conversation's prefix (`NIKCLI_COMPACTION_SHARED_PREFIX`), through the real prompt loop with only the
 * model faked. What is looked at is what the model is handed: the main turn's request and the compaction's, and the bytes the
 * Anthropic route would put on the wire for both.
 */

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-compaction-shared-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "0"
process.env.NIKCLI_DISABLE_MODELS_FETCH = "1"
preserveTestEnv([
  "NIKCLI_TEST_HOME",
  "NIKCLI_DISABLE_PROJECT_CONFIG",
  "NIKCLI_DISABLE_MODELS_FETCH",
  "NIKCLI_COMPACTION_SHARED_PREFIX",
  "NIKCLI_COMPACTION_TOOL_CHOICE",
])

const [
  { Session },
  { SessionPrompt },
  { SessionCompaction },
  { LLM },
  { Instance },
  { InstanceState, locallyInstance },
  { Effect },
] = await Promise.all([
  import("@/session"),
  import("@/session/prompt"),
  import("@/session/compaction"),
  import("@/session/llm"),
  import("@/project/instance"),
  import("@/effect"),
  import("effect"),
])

type StreamInput = Parameters<typeof LLM.stream>[0]
type Answer = { kind: "text"; text: string } | { kind: "tool-only" } | { kind: "text-and-tool"; text: string }

const directories: string[] = []
let streamSpy: ReturnType<typeof spyOn> | undefined
beforeEach(() => {
  delete process.env.NIKCLI_COMPACTION_SHARED_PREFIX
  delete process.env.NIKCLI_COMPACTION_TOOL_CHOICE
})
afterEach(() => {
  streamSpy?.mockRestore()
  streamSpy = undefined
})
afterAll(async () => {
  for (const directory of directories) await fs.rm(directory, { recursive: true, force: true })
  await removeTestDir(testHome)
})

async function project() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-compaction-shared-")))
  directories.push(directory)
  await Bun.write(
    path.join(directory, "nikcli.json"),
    JSON.stringify({
      provider: {
        "loop-test": {
          name: "Loop Test",
          api: "https://example.invalid/v1",
          npm: "@ai-sdk/openai-compatible",
          models: {
            "loop-model": {
              id: "loop-model",
              name: "Loop Model",
              release_date: "2026-01-01",
              limit: { context: 1_000_000, output: 8192 },
              cost: { input: 0, output: 0 },
            },
          },
        },
      },
      model: "loop-test/loop-model",
    }),
  )
  return directory
}

/** Records every request the model is handed. `answers` are the replies of the compaction requests, in order; a main turn says "answer". */
function fakeModel(answers: Answer[]) {
  const calls: { input: StreamInput; compaction: boolean }[] = []
  const queue = [...answers]
  streamSpy = spyOn(LLM, "stream").mockImplementation((async (input: StreamInput) => {
    if (input.small) return { text: Promise.resolve("title"), fullStream: (async function* () {})() }
    const compaction = input.agent.name === "compaction" || input.noToolCalls === true
    calls.push({ input, compaction })
    const answer: Answer = compaction
      ? (queue.shift() ?? { kind: "text", text: "summary" })
      : { kind: "text", text: "answer" }
    const text = answer.kind === "tool-only" ? undefined : answer.text
    const tool = answer.kind !== "text"
    return {
      text: Promise.resolve(""),
      fullStream: (async function* () {
        yield { type: "start" }
        yield { type: "start-step" }
        if (text !== undefined) {
          yield { type: "text-start", id: "t" }
          yield { type: "text-delta", id: "t", text }
          yield { type: "text-end", id: "t" }
        }
        // A model that is told not to call a tool and calls one anyway. With `noToolCalls` the stream layer drops it, so the fake does
        // what that layer does: nothing reaches the processor.
        if (tool && input.noToolCalls !== true) {
          yield { type: "tool-input-start", id: "c1", toolName: "bash" }
          yield { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "ls" } }
        }
        yield {
          type: "finish-step",
          finishReason: tool ? "tool-calls" : "stop",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          providerMetadata: undefined,
        }
        yield { type: "finish", finishReason: tool ? "tool-calls" : "stop" }
      })(),
    }
  }) as unknown as typeof LLM.stream)
  return calls
}

async function scenario(answers: Answer[]) {
  const calls = fakeModel(answers)
  const directory = await project()
  return Instance.provide({
    directory,
    fn: async () => {
      const ctx = InstanceState.ambient()
      const run = <A, E>(effect: import("effect").Effect.Effect<A, E, any>) =>
        Effect.runPromise(locallyInstance(ctx, effect as import("effect").Effect.Effect<A, E>))
      const sessionID = await run(
        Effect.gen(function* () {
          const session = yield* Session.Service
          const created = yield* session.createNext({
            directory,
            permission: [{ permission: "question", action: "deny", pattern: "*" }],
          })
          return created.id
        }).pipe(Effect.provide(Session.defaultLayer)),
      )
      const model = { providerID: "loop-test", modelID: "loop-model" }
      await run(
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          yield* prompt.prompt({
            sessionID,
            model,
            parts: [{ type: "text", text: "Read the repository and tell me what it is." }],
          })
        }).pipe(Effect.provide(SessionPrompt.defaultLayer)),
      )
      const turns = calls.length
      await run(
        Effect.gen(function* () {
          const compaction = yield* SessionCompaction.Service
          yield* compaction.create({ sessionID, agent: "build", model, auto: false })
        }).pipe(Effect.provide(SessionCompaction.defaultLayer)),
      )
      await run(
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          yield* prompt.loop(sessionID)
        }).pipe(Effect.provide(SessionPrompt.defaultLayer)),
      )
      const messages = await run(
        Effect.gen(function* () {
          const session = yield* Session.Service
          return yield* session.messages({ sessionID })
        }).pipe(Effect.provide(Session.defaultLayer)),
      )
      return { calls, turns, messages }
    },
  })
}

const anthropic = AnthropicMessages.model({
  id: "claude-sonnet-4-5",
  baseURL: "https://api.anthropic.test/v1/",
  headers: { "x-api-key": "test" },
})

/** The wire body the Anthropic route would send for what the loop handed the model. */
async function wire(input: StreamInput) {
  const request = LLM.buildLLMRequest(
    {
      system: input.system,
      messages: input.messages,
      tools: input.tools,
      deferred: input.deferred,
      toolChoice: input.noToolCalls
        ? LLM.uncallableToolChoice("anthropic-messages", input.toolChoice)
        : input.toolChoice,
    },
    anthropic,
    { maxOutputTokens: 4096 },
  )
  return (await Runtime.prepareRequest(request)).body as {
    system?: unknown
    tools?: unknown
    tool_choice?: unknown
    messages: unknown[]
  }
}

const summaryOf = (messages: Awaited<ReturnType<typeof scenario>>["messages"]) =>
  messages
    .filter((m) => m.info.role === "assistant" && (m.info as { summary?: boolean }).summary)
    .flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text))

describe("compaction with the shared prefix", () => {
  it("off (the default): the compaction is the request of today, with no system and no tools", async () => {
    const { calls, turns } = await scenario([])
    const compaction = calls.slice(turns).find((call) => call.compaction)!
    expect(compaction.input.system).toEqual([])
    expect(compaction.input.tools).toEqual({})
    expect(compaction.input.noToolCalls).toBeUndefined()
    expect(compaction.input.agent.name).toBe("compaction")
  })

  it("on: same system, same tools, the conversation's messages, then the summary instruction as the last user message", async () => {
    process.env.NIKCLI_COMPACTION_SHARED_PREFIX = "1"
    const { calls, turns, messages } = await scenario([{ kind: "text", text: "the summary" }])
    const main = calls[turns - 1]!.input
    const compaction = calls.slice(turns).find((call) => call.compaction)!.input

    expect(main.system.length).toBeGreaterThan(0)
    expect(Object.keys(main.tools).length).toBeGreaterThan(0)
    expect(compaction.system).toEqual(main.system)
    expect(Object.keys(compaction.tools)).toEqual(Object.keys(main.tools))
    expect(compaction.noToolCalls).toBe(true)
    // The messages of the main request come first and unchanged...
    expect(JSON.stringify(compaction.messages.slice(0, main.messages.length))).toBe(JSON.stringify(main.messages))
    // ...then only what happened since (the answer, the compaction's own user message), and the instruction last.
    const last = compaction.messages.at(-1)!
    expect(last.role).toBe("user")
    expect(JSON.stringify(last)).toContain("Provide a detailed prompt for continuing our conversation")
    expect(compaction.messages.slice(main.messages.length).map((m) => m.role)).toEqual(["assistant", "user", "user"])
    expect(summaryOf(messages)).toEqual(["the summary"])
  })

  it("on, the Anthropic wire: system and tools are the same bytes, the messages start with the main request's, tool_choice is unchanged", async () => {
    process.env.NIKCLI_COMPACTION_SHARED_PREFIX = "1"
    const { calls, turns } = await scenario([])
    const main = await wire(calls[turns - 1]!.input)
    const compaction = await wire(calls.slice(turns).find((call) => call.compaction)!.input)
    expect(JSON.stringify(compaction.system)).toBe(JSON.stringify(main.system))
    expect(JSON.stringify(compaction.tools)).toBe(JSON.stringify(main.tools))
    expect(JSON.stringify(compaction.tool_choice)).toBe(JSON.stringify(main.tool_choice))
    // The main request's last message carries a cache breakpoint the compaction's does not repeat in that place: the bytes of the
    // message content are what the cache matches on, so compare the messages without the markers.
    const bare = (messages: unknown[]) =>
      JSON.parse(JSON.stringify(messages).replaceAll(/,?"cache_control":\{[^}]*\}/g, ""))
    expect(bare(compaction.messages).slice(0, main.messages.length)).toEqual(bare(main.messages))
    expect(compaction.messages.length).toBeGreaterThan(main.messages.length)
    // Dump for the report, when asked for: `NIKCLI_DUMP_DIR=<dir> bun test ...`.
    if (process.env.NIKCLI_DUMP_DIR) {
      await Bun.write(
        path.join(process.env.NIKCLI_DUMP_DIR, "compaction-prefix-dump.json"),
        JSON.stringify({ main, compaction }, null, 2),
      )
    }
  })

  it("NIKCLI_COMPACTION_TOOL_CHOICE picks how the tools are made uncallable: same on Anthropic, none elsewhere, and the variable forces either", () => {
    expect(LLM.uncallableToolChoice("anthropic-messages", undefined)).toBeUndefined()
    expect(LLM.uncallableToolChoice("openai-responses", undefined)).toBe("none")
    process.env.NIKCLI_COMPACTION_TOOL_CHOICE = "none"
    expect(LLM.uncallableToolChoice("anthropic-messages", undefined)).toBe("none")
    process.env.NIKCLI_COMPACTION_TOOL_CHOICE = "same"
    expect(LLM.uncallableToolChoice("openai-responses", "required")).toBe("required")
  })

  it("an answer with only a tool call and no text: no empty summary is saved, the way of today answers, and a warn line says so", async () => {
    process.env.NIKCLI_COMPACTION_SHARED_PREFIX = "1"
    const warn = spyOn(Log.create({ service: "session.compaction" }), "warn")
    try {
      const { calls, turns, messages } = await scenario([
        { kind: "tool-only" },
        { kind: "text", text: "the summary from the old way" },
      ])
      const compactions = calls.slice(turns).filter((call) => call.compaction)
      expect(compactions).toHaveLength(2)
      expect(compactions[0]!.input.noToolCalls).toBe(true)
      expect(compactions[1]!.input.noToolCalls).toBeUndefined()
      expect(compactions[1]!.input.system).toEqual([])
      expect(summaryOf(messages)).toEqual(["the summary from the old way"])
      const line = warn.mock.calls.find((call) => call[0] === "compaction shared prefix fell back")
      expect(line?.[1]).toMatchObject({ reason: "tool_use_only", provider: "loop-test" })
      expect(line?.[1]).toHaveProperty("sessionID")
      expect(line?.[1]).toHaveProperty("toolChoice")
      // A fallback that works is not a failure for the circuit breaker.
      const sessionID = (line![1] as { sessionID: string }).sessionID
      expect(SessionCompaction.isCompactionCircuitOpen(sessionID)).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  it("text and a tool call: the text is the summary, no fallback", async () => {
    process.env.NIKCLI_COMPACTION_SHARED_PREFIX = "1"
    const warn = spyOn(Log.create({ service: "session.compaction" }), "warn")
    try {
      const { calls, turns, messages } = await scenario([{ kind: "text-and-tool", text: "summary and a stray call" }])
      expect(calls.slice(turns).filter((call) => call.compaction)).toHaveLength(1)
      expect(summaryOf(messages)).toEqual(["summary and a stray call"])
      expect(warn.mock.calls.some((call) => call[0] === "compaction shared prefix fell back")).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })
})
