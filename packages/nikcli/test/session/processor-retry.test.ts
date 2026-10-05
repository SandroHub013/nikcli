import { preserveTestEnv } from "../helpers/env"
import { afterAll, describe, expect, it, spyOn } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { removeTestDir } from "../helpers/fs"
import { InstanceState } from "@/effect"
import { APICallError } from "@/provider/error"
import type { MessageV2 as MessageTypes } from "@/session/message-v2"
import type { LLM as LLMTypes } from "@/session/llm"
import type { Provider } from "@/provider/provider"
import type { LLMEvent } from "@nikcli-ai/llm"
import { toProcessorStream } from "@/session/llm/llm-event-adapter"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-processor-retry-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"

preserveTestEnv(["NIKCLI_TEST_HOME", "NIKCLI_DISABLE_PROJECT_CONFIG"])

const [
  { SessionProcessor },
  { Session },
  { LLM },
  { SessionRetry },
  { locallyInstance },
  { Identifier },
  { Bus },
  { MessageV2 },
  { Instance },
  { Effect },
] = await Promise.all([
  import("@/session/processor"),
  import("@/session"),
  import("@/session/llm"),
  import("@/session/retry"),
  import("@/effect"),
  import("@nikcli-ai/util/id"),
  import("@/bus"),
  import("@/session/message-v2"),
  import("@/project/instance"),
  import("effect"),
])

afterAll(async () => {
  await removeTestDir(testHome)
})

type StreamEvent = LLMTypes.StreamOutput["fullStream"] extends AsyncIterable<infer Event> ? Event : never
const model: Provider.Model = {
  id: "test-model",
  providerID: "test-provider",
  name: "Retry test model",
  api: { id: "test-model", npm: "@ai-sdk/openai-compatible" },
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: false,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 8192, output: 1024 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-09-30",
}

function apiFailure(statusCode = 503, isRetryable = true) {
  return new APICallError({
    message: `Provider request failed (${statusCode})`,
    url: "https://provider.example.test/chat",
    requestBodyValues: {},
    statusCode,
    isRetryable,
    responseHeaders: { "retry-after-ms": "0" },
    responseBody: "request failed",
  })
}

async function* success(): AsyncGenerator<StreamEvent> {
  yield { type: "text-start", id: "text-success" }
  yield { type: "text-delta", id: "text-success", text: "recovered output" }
  yield { type: "text-end", id: "text-success" }
}

async function runProcessor(
  stream: (attempt: number) => AsyncIterable<StreamEvent>,
  options: { abort?: AbortController; sleep?: typeof SessionRetry.sleep } = {},
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-processor-retry-"))
  const abort = options.abort ?? new AbortController()
  const events: Array<{
    type: "updated" | "removed"
    partID: string
    text?: string
  }> = []
  const errors: Array<NonNullable<MessageTypes.Assistant["error"]>> = []
  let calls = 0
  const realSleep = SessionRetry.sleep
  // Only fullStream is consumed by the processor; the SDK result's other getters are not used.
  const streamSpy = spyOn(LLM, "stream").mockImplementation(
    async () => ({ fullStream: stream(++calls) }) as LLMTypes.StreamOutput,
  )
  const sleepSpy = spyOn(SessionRetry, "sleep").mockImplementation(options.sleep ?? realSleep)
  try {
    const persisted = await Instance.provide({
      directory,
      fn: async () => {
        const unsubscribeUpdate = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
          const part = event.properties.part
          events.push({
            type: "updated",
            partID: part.id,
            ...("text" in part ? { text: part.text } : {}),
          })
        })
        const unsubscribeRemove = Bus.subscribe(MessageV2.Event.PartRemoved, (event) =>
          events.push({ type: "removed", partID: event.properties.partID }),
        )
        const unsubscribeError = Bus.subscribe(Session.Event.Error, (event) => {
          if (event.properties.error) errors.push(event.properties.error)
        })
        try {
          return await Effect.runPromise(
            locallyInstance(
              {
                directory,
                worktree: Instance.worktree,
                project: Instance.project,
              },
              Effect.gen(function* () {
                const session = yield* Session.Service
                const created = yield* session.createNext({
                  directory,
                  title: "Processor retry",
                })
                const assistantMessage: MessageTypes.Assistant = {
                  id: Identifier.ascending("message"),
                  sessionID: created.id,
                  role: "assistant" as const,
                  parentID: Identifier.ascending("message"),
                  agent: "build",
                  mode: "build",
                  providerID: model.providerID,
                  modelID: model.id,
                  path: { cwd: directory, root: directory },
                  time: { created: Date.now() },
                  cost: 0,
                  tokens: {
                    input: 0,
                    output: 0,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  },
                }
                yield* session.updateMessage(assistantMessage)
                const processor = yield* SessionProcessor.Service
                const instance = yield* InstanceState.context
                const result = yield* processor.create({
                  instance,
                  assistantMessage,
                  sessionID: created.id,
                  model,
                  abort: abort.signal,
                })
                yield* Effect.promise(() =>
                  result.process({
                    user: {
                      id: assistantMessage.parentID,
                      sessionID: created.id,
                      role: "user",
                      time: { created: Date.now() },
                      agent: "build",
                      model: {
                        providerID: model.providerID,
                        modelID: model.id,
                      },
                    },
                    sessionID: created.id,
                    model,
                    agent: {
                      name: "build",
                      mode: "primary",
                      permission: [],
                      options: {},
                    },
                    system: [],
                    abort: abort.signal,
                    messages: [],
                    tools: {},
                  }),
                )
                const messages = yield* session.messages({
                  sessionID: created.id,
                })
                const message = messages.find((message) => message.info.id === assistantMessage.id)
                if (!message || message.info.role !== "assistant") throw new Error("Missing persisted assistant")
                return {
                  info: message.info,
                  parts: message.parts,
                  processorError: result.message.error,
                }
              }).pipe(Effect.provide(Session.defaultLayer), Effect.provide(SessionProcessor.defaultLayer)),
            ),
          )
        } finally {
          unsubscribeUpdate()
          unsubscribeRemove()
          unsubscribeError()
          await Instance.dispose()
        }
      },
    })

    return {
      ...persisted,
      events,
      errors,
      calls,
      waits: sleepSpy.mock.calls.map(([ms]) => ms),
    }
  } finally {
    streamSpy.mockRestore()
    sleepSpy.mockRestore()
    await removeTestDir(directory)
  }
}

describe("SessionProcessor retry safety", () => {
  it("does not replay a completed text part when the next stream event fails", async () => {
    const result = await runProcessor(async function* () {
      yield* success()
      throw apiFailure()
    })
    expect(result.calls).toBe(1)
    expect(result.waits).toEqual([])
    expect(result.events.some((event) => event.type === "removed")).toBe(false)
    expect(result.parts).toMatchObject([{ type: "text", text: "recovered output" }])
    expect(result.info.error).toMatchObject({
      name: "APIError",
      data: { statusCode: 503 },
    })
  })

  it("retries after an empty reasoning start without publishing the discarded part", async () => {
    const result = await runProcessor(async function* (attempt) {
      if (attempt === 1) {
        yield { type: "reasoning-start", id: "reasoning-1" }
        throw apiFailure()
      }
      throw new DOMException("Interrupted", "AbortError")
    })
    expect(result.parts).toHaveLength(0)
    expect(result.calls).toBe(2)
    const removed = result.events.findIndex((event) => event.type === "removed")
    expect(removed).toBeGreaterThanOrEqual(0)
    expect(
      result.events
        .slice(removed + 1)
        .some((event) => event.type === "updated" && event.partID === result.events[removed]?.partID),
    ).toBe(false)
  })

  it("retries a transient APICallError before output and persists successful output", async () => {
    const result = await runProcessor(async function* (attempt) {
      if (attempt === 1) throw apiFailure()
      yield* success()
    })
    expect(result.calls).toBe(2)
    expect(result.waits).toEqual([0])
    expect(result.errors).toEqual([])
    expect(result.info.error).toBeUndefined()
    expect(result.info.time.completed).toBeNumber()
    expect(result.parts).toMatchObject([{ type: "text", text: "recovered output" }])
  })

  it("exhausts RETRY_MAX_ATTEMPTS with six calls, five waits, and a persisted terminal APIError", async () => {
    const result = await runProcessor(async function* () {
      throw apiFailure()
    })
    expect(SessionRetry.RETRY_MAX_ATTEMPTS).toBe(5)
    expect(result.calls).toBe(6)
    expect(result.waits).toEqual([0, 0, 0, 0, 0])
    expect(result.info.error).toMatchObject({
      name: "APIError",
      data: {
        statusCode: 503,
        isRetryable: true,
        responseHeaders: { "retry-after-ms": "0" },
      },
    })
    expect(result.info.time.completed).toBeNumber()
    expect(result.errors).toEqual([result.info.error] as typeof result.errors)
    expect(result.parts).toHaveLength(0)
  })

  for (const status of [401, 400]) {
    it(`does not retry non-retryable HTTP ${status}`, async () => {
      const result = await runProcessor(async function* () {
        throw apiFailure(status, false)
      })
      expect(result.calls).toBe(1)
      expect(result.waits).toEqual([])
      expect(result.info.error).toMatchObject({
        name: "APIError",
        data: { statusCode: status, isRetryable: false },
      })
      expect(result.info.time.completed).toBeNumber()
      expect(result.errors).toEqual([result.info.error] as typeof result.errors)
    })
  }

  it("persists cancellation during backoff without a second provider call", async () => {
    const abort = new AbortController()
    const realSleep = SessionRetry.sleep
    const result = await runProcessor(
      async function* () {
        throw apiFailure()
      },
      {
        abort,
        sleep: (ms, signal) => {
          const pending = realSleep(ms, signal)
          abort.abort()
          return pending
        },
      },
    )
    expect(result.calls).toBe(1)
    expect(result.waits).toEqual([0])
    expect(result.processorError).toMatchObject({
      name: "MessageAbortedError",
      data: { message: "Aborted" },
    })
    expect(result.errors).toEqual([result.processorError] as typeof result.errors)
    expect(result.info.error).toEqual(result.processorError)
    expect(result.info.time.completed).toBeNumber()
    expect(result.parts).toHaveLength(0)
  })

  it("persists a provider stream AbortError and flushes its partial text without retry", async () => {
    const result = await runProcessor(async function* () {
      yield { type: "text-start", id: "interrupted" }
      yield { type: "text-delta", id: "interrupted", text: "partial output" }
      throw new DOMException("Interrupted", "AbortError")
    })
    expect(result.calls).toBe(1)
    expect(result.waits).toEqual([])
    expect(result.info.error).toMatchObject({
      name: "MessageAbortedError",
      data: { message: "Interrupted" },
    })
    expect(result.info.time.completed).toBeNumber()
    expect(result.errors).toEqual([result.info.error] as typeof result.errors)
    expect(result.parts).toMatchObject([{ type: "text", text: "partial output" }])
  })

  for (const kind of ["reasoning", "text"] as const) {
    it(`preserves partial ${kind} published to Bus and stops without retry`, async () => {
      const result = await runProcessor(async function* (attempt) {
        if (attempt === 1) {
          if (kind === "reasoning") {
            yield { type: "reasoning-start", id: "partial" }
            yield {
              type: "reasoning-delta",
              id: "partial",
              text: "partial output",
            }
          } else {
            yield { type: "text-start", id: "partial" }
            yield { type: "text-delta", id: "partial", text: "partial output" }
          }
          throw apiFailure()
        }
        yield* success()
      })
      expect(result.calls).toBe(1)
      expect(result.waits).toEqual([])
      const partial = result.events.findIndex((event) => event.type === "updated" && event.text === "partial output")
      expect(partial).toBeGreaterThanOrEqual(0)
      const removed = result.events.findIndex(
        (event) => event.type === "removed" && event.partID === result.events[partial]?.partID,
      )
      expect(removed).toBe(-1)
      expect(result.events.some((event) => event.text === "recovered output")).toBe(false)
      expect(result.parts).toMatchObject([{ type: kind, text: "partial output" }])
      expect(result.info.error).toMatchObject({
        name: "APIError",
        data: { statusCode: 503 },
      })
      expect(result.errors).toEqual([result.info.error] as typeof result.errors)
      expect(result.info.time.completed).toBeNumber()
    })
  }

  it("does not retry after publishing a pending tool, and persists its interruption", async () => {
    const result = await runProcessor(async function* () {
      yield { type: "tool-input-start", id: "tool-1", toolName: "read" }
      throw apiFailure()
    })
    expect(result.calls).toBe(1)
    expect(result.waits).toEqual([])
    expect(result.events.some((event) => event.type === "removed")).toBe(false)
    expect(result.parts).toMatchObject([
      {
        type: "tool",
        callID: "tool-1",
        state: {
          status: "error",
          error: "Tool execution interrupted before completion",
        },
      },
    ])
    expect(result.info.error).toMatchObject({
      name: "APIError",
      data: { statusCode: 503 },
    })
    expect(result.errors).toEqual([result.info.error] as typeof result.errors)
  })

  it("retries after empty text deltas that have not been published", async () => {
    const result = await runProcessor(async function* (attempt) {
      if (attempt === 1) {
        yield { type: "text-start", id: "empty" }
        yield { type: "text-delta", id: "empty", text: "" }
        throw apiFailure()
      }
      yield* success()
    })
    expect(result.calls).toBe(2)
    expect(result.waits).toEqual([0])
    expect(result.parts).toMatchObject([{ type: "text", text: "recovered output" }])
    expect(result.info.error).toBeUndefined()
  })

  for (const kind of ["text", "reasoning"] as const) {
    it(`stops a native provider failure after partial ${kind} without retrying`, async () => {
      async function* native(): AsyncGenerator<LLMEvent> {
        yield {
          type: `${kind}-delta`,
          id: "native-part",
          text: "native partial output",
        }
        yield {
          type: "provider-error",
          message: "overloaded",
          retryable: true,
          providerMetadata: { provider: { statusCode: 503 } },
        }
      }
      const result = await runProcessor(() => toProcessorStream(native()))
      expect(result.calls).toBe(1)
      expect(result.waits).toEqual([])
      expect(result.events.some((event) => event.type === "removed")).toBe(false)
      // The native stream opens its step like any other, so a step-start part leads the content.
      expect(result.parts.filter((part) => part.type !== "step-start")).toMatchObject([
        { type: kind, text: "native partial output" },
      ])
      expect(result.parts.some((part) => part.type === "step-finish")).toBe(false)
      expect(result.info.finish).toBeUndefined()
      expect(result.info.error).toMatchObject({
        name: "APIError",
        data: { statusCode: 503 },
      })
      expect(result.errors).toEqual([result.info.error] as typeof result.errors)
    })
  }
})
