import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import type { Effect as EffectType } from "effect"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-session-generate-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "0"
process.env.NIKCLI_DISABLE_MODELS_FETCH = "1"

preserveTestEnv(["NIKCLI_TEST_HOME", "NIKCLI_DISABLE_PROJECT_CONFIG", "NIKCLI_DISABLE_MODELS_FETCH"])

const [
  { Session },
  { SessionPrompt },
  { SessionStatus },
  { LLM },
  { InstructionSync },
  { Instance },
  { InstanceState, locallyInstance },
  { Identifier },
  { Effect, Fiber },
] = await Promise.all([
  import("@/session"),
  import("@/session/prompt"),
  import("@/session/status"),
  import("@/session/llm"),
  import("@/session/instruction-sync"),
  import("@/project/instance"),
  import("@/effect"),
  import("@nikcli-ai/util/id"),
  import("effect"),
])

type StreamInput = Parameters<typeof LLM.stream>[0]

const directories: string[] = []

afterEach(() => {
  streamSpy?.mockRestore()
  streamSpy = undefined
})

afterAll(async () => {
  await Instance.disposeAll()
  for (const directory of directories) await removeTestDir(directory)
  const { Database } = await import("@/database/database")
  Database.closeAll()
  await removeTestDir(testHome)
})

let streamSpy: ReturnType<typeof spyOn> | undefined

/** Replaces the model call; `events` is what the provider "streams" back. */
function stubStream(events: Array<Record<string, unknown>>) {
  const calls: StreamInput[] = []
  streamSpy = spyOn(LLM, "stream").mockImplementation((async (input: StreamInput) => {
    calls.push(input)
    return {
      // What the native runtime hands back: the answer is only in the deltas.
      text: Promise.resolve(""),
      fullStream: (async function* () {
        for (const event of events) {
          if (event.type === "throw") throw event.error
          yield event
        }
      })(),
    }
  }) as unknown as typeof LLM.stream)
  return calls
}

async function project() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-session-generate-")))
  directories.push(directory)
  await Bun.write(
    path.join(directory, "nikcli.json"),
    JSON.stringify({
      provider: {
        "generate-test": {
          name: "Generate Test",
          api: "https://example.invalid/v1",
          npm: "@ai-sdk/openai-compatible",
          models: {
            "generate-model": {
              id: "generate-model",
              name: "Generate Model",
              release_date: "2026-01-01",
              limit: { context: 8192, output: 1024 },
              cost: { input: 0, output: 0 },
            },
          },
        },
      },
      model: "generate-test/generate-model",
    }),
  )
  return directory
}

/** Runs `body` inside the directory's real instance, with a session seeded by `seed`. */
async function inSession<T>(
  seed: "conversation" | "empty",
  body: (input: {
    sessionID: string
    snapshot: () => Promise<unknown>
    run: <A, E>(effect: EffectType.Effect<A, E, any>) => Promise<A>
  }) => Promise<T>,
) {
  const directory = await project()
  return Instance.provide({
    directory,
    fn: async () => {
      const ctx = InstanceState.ambient()
      const run = <A, E>(effect: EffectType.Effect<A, E, any>) =>
        Effect.runPromise(locallyInstance(ctx, Effect.provide(effect, Session.defaultLayer) as EffectType.Effect<A, E>))
      const sessionID = await run(
        Effect.gen(function* () {
          const session = yield* Session.Service
          const created = yield* session.createNext({ directory, title: "Generate" })
          if (seed === "empty") return created.id
          const messageID = Identifier.ascending("message")
          yield* session.updateMessage({
            id: messageID,
            sessionID: created.id,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: "generate-test", modelID: "generate-model" },
          } as any)
          yield* session.updatePart({
            id: Identifier.ascending("part"),
            messageID,
            sessionID: created.id,
            type: "text",
            text: "Refactor the parser to stream tokens.",
          } as any)
          return created.id
        }),
      )
      // Everything `generate` could write: messages and their parts, the
      // session row itself, and the status map.
      const snapshot = () =>
        run(
          Effect.gen(function* () {
            const session = yield* Session.Service
            const status = yield* SessionStatus.Service
            return {
              messages: yield* session.messages({ sessionID }),
              info: yield* session.get(sessionID),
              status: (yield* status.list())[sessionID],
            }
          }).pipe(Effect.provide(SessionStatus.defaultLayer)),
        )
      return body({ sessionID, snapshot, run })
    },
  })
}

function generate(sessionID: string, prompt: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* SessionPrompt.Service
      return yield* service.generate({ sessionID, prompt })
    }).pipe(Effect.provide(SessionPrompt.defaultLayer), (effect) => locallyInstance(InstanceState.ambient(), effect)),
  )
}

describe("SessionPrompt.generate", () => {
  it("answers from the session context and writes nothing back", async () => {
    const calls = stubStream([
      { type: "start-step" },
      { type: "text-delta", id: "t1", text: "It streams " },
      { type: "text-delta", id: "t1", text: "tokens lazily." },
      { type: "finish-step", finishReason: "stop" },
      { type: "finish", finishReason: "stop" },
    ])

    await inSession("conversation", async ({ sessionID, snapshot }) => {
      const before = await snapshot()
      const result = await generate(sessionID, "btw: what does the parser change do?")

      expect(result).toEqual({
        text: "It streams tokens lazily.",
        agent: "build",
        model: { providerID: "generate-test", modelID: "generate-model" },
        finish: "stop",
      })
      expect(await snapshot()).toEqual(before)

      expect(calls).toHaveLength(1)
      const call = calls[0]!
      expect(call.sessionID).toBe(sessionID)
      expect(call.model.providerID).toBe("generate-test")
      expect(call.model.id).toBe("generate-model")
      expect(call.agent.name).toBe("build")
      // The committed history comes first, the side question last.
      expect(JSON.stringify(call.messages)).toContain("Refactor the parser to stream tokens.")
      expect(call.messages.at(-1)).toEqual({ role: "user", content: "btw: what does the parser change do?" })
      // Same system prefix a loop step sends, read without committing.
      expect(call.system).toEqual(InstructionSync.render(sessionID, (before as any).info.projectID).system)
      // Tool definitions ride along for prompt-cache parity, but none can run.
      expect(Object.keys(call.tools).length).toBeGreaterThan(0)
      for (const tool of Object.values(call.tools)) expect(tool.execute).toBeUndefined()
    })
  })

  it("drops a tool call instead of running it, and returns the empty answer", async () => {
    stubStream([
      { type: "tool-call", toolCallId: "call_1", toolName: "bash", input: { command: "rm -rf /" } },
      { type: "finish", finishReason: "tool-calls" },
    ])

    await inSession("conversation", async ({ sessionID, snapshot }) => {
      const before = await snapshot()
      expect(await generate(sessionID, "list the files")).toMatchObject({ text: "", finish: "tool-calls" })
      expect(await snapshot()).toEqual(before)
    })
  })

  it("fails with the provider's error and leaves the session untouched", async () => {
    stubStream([{ type: "error", error: new Error("provider exploded") }])

    await inSession("conversation", async ({ sessionID, snapshot }) => {
      const before = await snapshot()
      await expect(generate(sessionID, "anything")).rejects.toThrow("provider exploded")
      expect(await snapshot()).toEqual(before)
    })
  })

  it("refuses a session with no conversation yet, without calling the model", async () => {
    const calls = stubStream([])

    await inSession("empty", async ({ sessionID }) => {
      await expect(generate(sessionID, "anything")).rejects.toThrow("no conversation")
      expect(calls).toHaveLength(0)
    })
  })

  it("forks with the side answer as a finished turn, leaving the source untouched", async () => {
    stubStream([
      { type: "text-delta", id: "t1", text: "Because tokens arrive lazily." },
      { type: "finish", finishReason: "stop" },
    ])

    await inSession("conversation", async ({ sessionID, snapshot, run }) => {
      const before = await snapshot()
      const answer = await generate(sessionID, "btw: why stream?")
      const forked = await run(
        Effect.gen(function* () {
          const session = yield* Session.Service
          const fork = yield* session.fork({
            sessionID,
            continuation: {
              prompt: "why stream?",
              response: answer.text,
              agent: answer.agent,
              model: answer.model,
              finish: answer.finish,
            },
          })
          return { fork, messages: yield* session.messages({ sessionID: fork.id }) }
        }),
      ).then(({ fork, messages }) => {
        // Continuable: not a subagent child, which the TUI would render without a prompt.
        expect(fork.parentID).toBeUndefined()
        return messages
      })

      expect(await snapshot()).toEqual(before)
      // The source's conversation, then the side question and its exact answer.
      expect(forked.map((message) => message.info.role)).toEqual(["user", "user", "assistant"])
      const [original, question, reply] = forked
      expect(original!.parts).toMatchObject([{ type: "text", text: "Refactor the parser to stream tokens." }])
      expect(question!.parts).toMatchObject([{ type: "text", text: "why stream?" }])
      expect(question!.info).toMatchObject({
        agent: "build",
        model: { providerID: "generate-test", modelID: "generate-model" },
      })
      expect(reply!.parts).toMatchObject([{ type: "text", text: "Because tokens arrive lazily." }])
      expect(reply!.info).toMatchObject({
        role: "assistant",
        parentID: question!.info.id,
        agent: "build",
        providerID: "generate-test",
        modelID: "generate-model",
        finish: "stop",
        cost: 0,
      })
      expect((reply!.info as { time: { completed?: number } }).time.completed).toBeNumber()
    })
  })

  it("aborts the model call when the caller is interrupted", async () => {
    let seen: AbortSignal | undefined
    streamSpy = spyOn(LLM, "stream").mockImplementation((async (input: StreamInput) => {
      seen = input.abort
      return {
        fullStream: (async function* () {
          await new Promise((resolve) => input.abort.addEventListener("abort", resolve, { once: true }))
          yield { type: "error", error: new DOMException("Aborted", "AbortError") }
        })(),
      }
    }) as unknown as typeof LLM.stream)

    await inSession("conversation", async ({ sessionID }) => {
      const fiber = Effect.runFork(
        Effect.gen(function* () {
          const service = yield* SessionPrompt.Service
          return yield* service.generate({ sessionID, prompt: "slow question" })
        }).pipe(Effect.provide(SessionPrompt.defaultLayer), (effect) =>
          locallyInstance(InstanceState.ambient(), effect),
        ),
      )
      for (let i = 0; i < 200 && !seen; i++) await Bun.sleep(5)
      expect(seen?.aborted).toBe(false)
      await Effect.runPromise(Fiber.interrupt(fiber))
      expect(seen?.aborted).toBe(true)
    })
  })
})
