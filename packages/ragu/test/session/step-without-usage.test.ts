import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

/**
 * Review of the UI, P0: a provider that sends no `usage` on its finish event (the simulation's OpenAI backend is
 * one) made every turn end with `TypeError: undefined is not an object (evaluating 'input.usage.inputTokens')`
 * on screen. The real prompt loop, with only the model faked: a step that finishes without usage must end
 * cleanly, count nothing, and leave what an earlier step counted as it was.
 */

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "ragu-step-without-usage-home-"))
process.env.RAGU_TEST_HOME = testHome
process.env.RAGU_DISABLE_PROJECT_CONFIG = "0"
process.env.RAGU_DISABLE_MODELS_FETCH = "1"
preserveTestEnv(["RAGU_TEST_HOME", "RAGU_DISABLE_PROJECT_CONFIG", "RAGU_DISABLE_MODELS_FETCH"])

const [{ Session }, { SessionPrompt }, { LLM }, { Instance }, { InstanceState, locallyInstance }, { Effect }] =
  await Promise.all([
    import("@/session"),
    import("@/session/prompt"),
    import("@/session/llm"),
    import("@/project/instance"),
    import("@/effect"),
    import("effect"),
  ])

type StreamInput = Parameters<typeof LLM.stream>[0]

const directories: string[] = []
let streamSpy: ReturnType<typeof spyOn> | undefined
afterEach(() => {
  streamSpy?.mockRestore()
  streamSpy = undefined
})
afterAll(async () => {
  for (const directory of directories) await fs.rm(directory, { recursive: true, force: true })
  await removeTestDir(testHome)
})

async function project() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ragu-step-without-usage-")))
  directories.push(directory)
  await Bun.write(
    path.join(directory, "nikcli.json"),
    JSON.stringify({
      provider: {
        "usage-test": {
          name: "Usage Test",
          api: "https://example.invalid/v1",
          npm: "@ai-sdk/openai-compatible",
          models: {
            "usage-model": {
              id: "usage-model",
              name: "Usage Model",
              release_date: "2026-01-01",
              limit: { context: 1_000_000, output: 8192 },
              // A million per million tokens: the cost of a step is its token count, easy to read.
              cost: { input: 1_000_000, output: 1_000_000 },
            },
          },
        },
      },
      model: "usage-test/usage-model",
    }),
  )
  return directory
}

type Usage = { inputTokens: number; outputTokens: number; totalTokens: number } | undefined

/** A model that answers one step per entry of `usages`: a tool call for all but the last, which ends the turn. */
function fakeModel(usages: Usage[]) {
  let step = 0
  streamSpy = spyOn(LLM, "stream").mockImplementation((async (input: StreamInput) => {
    if (input.small) return { text: Promise.resolve("title"), fullStream: (async function* () {})() }
    const n = ++step
    const last = n === usages.length
    return {
      text: Promise.resolve(""),
      fullStream: (async function* () {
        yield { type: "start" }
        yield { type: "start-step" }
        if (last) {
          yield { type: "text-start", id: "t" }
          yield { type: "text-delta", id: "t", text: "done" }
          yield { type: "text-end", id: "t" }
        } else {
          const id = `call_${n}`
          const toolInput = { command: `echo ${n}`, timeout: 10000, description: "say a number" }
          yield { type: "tool-input-start", id, toolName: "bash" }
          yield { type: "tool-call", toolCallId: id, toolName: "bash", input: toolInput }
          yield {
            type: "tool-result",
            toolCallId: id,
            input: toolInput,
            output: { output: String(n), metadata: {}, title: "bash" },
          }
        }
        // `usage` is left out altogether when the step has none: what a provider that sends none produces.
        const usage = usages[n - 1]
        yield {
          type: "finish-step",
          finishReason: last ? "stop" : "tool-calls",
          ...(usage ? { usage } : {}),
          providerMetadata: undefined,
        }
        yield { type: "finish", finishReason: last ? "stop" : "tool-calls" }
      })(),
    }
  }) as unknown as typeof LLM.stream)
}

async function runTurn(usages: Usage[]) {
  fakeModel(usages)
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
      await run(
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          yield* prompt.prompt({
            sessionID,
            model: { providerID: "usage-test", modelID: "usage-model" },
            parts: [{ type: "text", text: "Say it." }],
          })
        }).pipe(Effect.provide(SessionPrompt.defaultLayer)),
      )
      const messages = await run(
        Effect.gen(function* () {
          const session = yield* Session.Service
          return yield* session.messages({ sessionID })
        }).pipe(Effect.provide(Session.defaultLayer)),
      )
      return messages.filter((m) => m.info.role === "assistant")
    },
  })
}

const stepFinishes = (message: { parts: { type: string }[] }) =>
  message.parts.filter((p) => p.type === "step-finish") as unknown as {
    cost: number
    tokens: { total?: number; input: number; output: number }
  }[]

describe("a step that finishes without usage", () => {
  it("ends the turn cleanly and counts nothing: no error on the message, no tokens made up", async () => {
    const assistants = await runTurn([undefined])
    expect(assistants).toHaveLength(1)
    const info = assistants[0]!.info as { error?: unknown; finish?: string; cost: number; tokens: { input: number } }
    expect(info.error).toBeUndefined()
    expect(info.finish).toBe("stop")
    expect(info.cost).toBe(0)
    expect(info.tokens.input).toBe(0)
    // The step is still recorded, with the schema's zeros and without a total: nothing says it was measured.
    const [finished] = stepFinishes(assistants[0]!)
    expect(finished).toBeDefined()
    expect(finished!.tokens.total).toBeUndefined()
  })

  it("leaves a step that did report usage as it was counted", async () => {
    const assistants = await runTurn([{ inputTokens: 100, outputTokens: 20, totalTokens: 120 }, undefined])
    expect(assistants.length).toBeGreaterThanOrEqual(2)
    for (const message of assistants) expect((message.info as { error?: unknown }).error).toBeUndefined()
    const counted = assistants[0]!.info as { cost: number; tokens: { input: number; output: number } }
    expect(counted.tokens).toMatchObject({ input: 100, output: 20 })
    expect(counted.cost).toBeCloseTo(120, 6)
    const [first] = stepFinishes(assistants[0]!)
    expect(first!.tokens).toMatchObject({ input: 100, output: 20, total: 120 })
    const uncounted = assistants.at(-1)!.info as { cost: number; tokens: { input: number } }
    expect(uncounted.cost).toBe(0)
    expect(uncounted.tokens.input).toBe(0)
  })
})
