import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

/**
 * The real prompt loop, with only the model faked. A 90-step ARC run kept growing to a 160k-token
 * prompt with `pruneLoop` never firing: nearly all of that prompt was replayed reasoning, and the
 * tool outputs were too small to add up to the half budget the prune wanted to free. This drives
 * `SessionPrompt.prompt` through many steps of the same shape (small tool output, large reasoning
 * metadata) and looks at the prompts the model is actually handed.
 */

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-loop-prune-loop-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "0"
process.env.NIKCLI_DISABLE_MODELS_FETCH = "1"
preserveTestEnv(["NIKCLI_TEST_HOME", "NIKCLI_DISABLE_PROJECT_CONFIG", "NIKCLI_DISABLE_MODELS_FETCH"])

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

const STEPS = 24
const BUDGET = 20_000
const KEEP = 6_000
const REASONING_CHARS = 8_000 // ~2k tokens of replayed reasoning per step, the ARC shape
const OUTPUT_CHARS = 1_200 // ~300 tokens of tool output per step
const est = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4)

async function project(compaction: object) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-loop-prune-loop-")))
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
      compaction,
    }),
  )
  return directory
}

/**
 * A model that takes `STEPS` tool-calling steps. Its prompt size is measured off the messages it is
 * handed, so it reports what a provider would have counted.
 */
function fakeModel(STEPS: number) {
  const prompts: number[] = []
  let step = 0
  streamSpy = spyOn(LLM, "stream").mockImplementation((async (input: StreamInput) => {
    if (input.small) return { text: Promise.resolve("title"), fullStream: (async function* () {})() }
    const n = ++step
    const promptTokens = est(input.messages)
    prompts.push(promptTokens)
    const details = { openrouter: { reasoning_details: [{ type: "reasoning.encrypted", data: "z".repeat(REASONING_CHARS) }] } }
    return {
      text: Promise.resolve(""),
      fullStream: (async function* () {
        yield { type: "start" }
        yield { type: "start-step" }
        if (n === STEPS) {
          yield { type: "text-start", id: "t" }
          yield { type: "text-delta", id: "t", text: "done" }
          yield { type: "text-end", id: "t" }
        } else {
          yield { type: "reasoning-start", id: `r${n}`, providerMetadata: details }
          yield { type: "reasoning-delta", id: `r${n}`, text: "thinking about the board", providerMetadata: details }
          yield { type: "reasoning-end", id: `r${n}` }
          const id = `call_${n}`
          // The shape of an ARC bash call: the arguments outweigh the command itself.
          const toolInput = {
            command: `arc3 act ACTION6 ${n} ${n}`,
            timeout: 10000,
            workdir: "C:/sbx/arc3-runs/nikcli-406y2/ft09-0d8bbf25/r1/workspace",
            description: "Tests a click in the outlined right panel",
          }
          yield { type: "tool-input-start", id, toolName: "bash" }
          yield { type: "tool-call", toolCallId: id, toolName: "bash", input: toolInput, providerMetadata: details }
          yield {
            type: "tool-result",
            toolCallId: id,
            input: toolInput,
            output: { output: "o".repeat(OUTPUT_CHARS), metadata: {}, title: "bash" },
          }
        }
        yield {
          type: "finish-step",
          finishReason: n === STEPS ? "stop" : "tool-calls",
          usage: {
            inputTokens: promptTokens,
            outputTokens: 60,
            // The reasoning is in the prompt twice here (the part and the tool call carry the same details).
            reasoningTokens: n === STEPS ? 0 : REASONING_CHARS / 2,
            totalTokens: promptTokens + 60,
          },
          providerMetadata: undefined,
        }
        yield { type: "finish", finishReason: n === STEPS ? "stop" : "tool-calls" }
      })(),
    }
  }) as unknown as typeof LLM.stream)
  return prompts
}

async function runLoop(compaction: object, steps = STEPS) {
  const prompts = fakeModel(steps)
  const directory = await project(compaction)
  return Instance.provide({
    directory,
    fn: async () => {
      const ctx = InstanceState.ambient()
      const run = <A, E>(effect: import("effect").Effect.Effect<A, E, any>) =>
        Effect.runPromise(locallyInstance(ctx, effect as import("effect").Effect.Effect<A, E>))
      const sessionID = await run(
        Effect.gen(function* () {
          const session = yield* Session.Service
          // What `nikcli run` puts on its sessions: nobody to ask, so no title calls to the model.
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
            model: { providerID: "loop-test", modelID: "loop-model" },
            parts: [{ type: "text", text: "Play the game." }],
          })
        }).pipe(Effect.provide(SessionPrompt.defaultLayer)),
      )
      const messages = await run(
        Effect.gen(function* () {
          const session = yield* Session.Service
          return yield* session.messages({ sessionID })
        }).pipe(Effect.provide(Session.defaultLayer)),
      )
      return { prompts, messages }
    },
  })
}

describe("the prompt loop prunes a long single-message task", () => {
  it("brings the prompt down once it passes the budget, and clears the old steps' reasoning", async () => {
    const { prompts, messages } = await runLoop({ pruneBudget: BUDGET, pruneKeep: KEEP })
    expect(prompts).toHaveLength(STEPS)

    // The model is handed a smaller prompt at some step (a prune), and never one near what 24 unpruned
    // steps add up to (~150k here): it saw-tooths between the keep target and a bit over the budget.
    const drops = prompts.filter((p, k) => k > 0 && p < prompts[k - 1]! * 0.6)
    expect(drops.length).toBeGreaterThan(0)
    expect(Math.max(...prompts)).toBeLessThan(BUDGET * 3)
    expect(prompts.at(-1)!).toBeLessThan(BUDGET * 3)

    const steps = messages.filter((m) => m.info.role === "assistant")
    const tools = steps.flatMap((m) => m.parts.filter((p) => p.type === "tool"))
    const first = tools[0] as { state: { time: { compacted?: number } }; metadata?: Record<string, unknown> }
    const last = tools.at(-1) as typeof first
    expect(first.state.time.compacted).toBeNumber()
    expect(first.metadata?.["nikcliReplayCleared"]).toBe(true)
    expect(last.state.time.compacted).toBeUndefined()
    expect(last.metadata?.["nikcliReplayCleared"]).toBeUndefined()
    const reasoning = steps[0]!.parts.filter((p) => p.type === "reasoning") as unknown as {
      text: string
      metadata?: Record<string, unknown>
    }[]
    // Cleared from the prompt, still stored for whoever reads the transcript.
    expect(reasoning[0]!.metadata?.["nikcliReplayCleared"]).toBe(true)
    expect(reasoning[0]!.text).toContain("thinking about the board")
  })

  it("leaves the prompt growing when pruning is off", async () => {
    const { prompts, messages } = await runLoop({ prune: false, pruneBudget: BUDGET, pruneKeep: KEEP })
    for (let i = 1; i < prompts.length; i++) expect(prompts[i]).toBeGreaterThan(prompts[i - 1]!)
    const tools = messages.flatMap((m) => m.parts.filter((p) => p.type === "tool"))
    expect(tools.some((p) => (p as { state: { time: { compacted?: number } } }).state.time.compacted)).toBe(false)
  })

  it("with pruneReasoning off it clears outputs only, so the reasoning still grows the prompt", async () => {
    const { prompts, messages } = await runLoop({ pruneBudget: BUDGET, pruneKeep: KEEP, pruneReasoning: false })
    // Outputs are ~300 tokens a step: never half a budget, so nothing is cleared and it keeps growing.
    expect(prompts.at(-1)!).toBeGreaterThan(prompts[0]! * 5)
    const tools = messages.flatMap((m) => m.parts.filter((p) => p.type === "tool"))
    expect(tools.some((p) => (p as { metadata?: Record<string, unknown> }).metadata?.["nikcliReplayCleared"])).toBe(false)
  })
})

describe("old cleared steps are folded into a digest", () => {
  const floors = (prompts: number[]) => prompts.filter((p, k) => k > 0 && p < prompts[k - 1]! * 0.7)

  it("keeps the prompt's floor from climbing with every step of the task", async () => {
    const config = { pruneBudget: BUDGET, pruneKeep: KEEP, pruneDigestKeep: 4 }
    const folded = await runLoop(config, 70)
    const plain = await runLoop({ ...config, pruneDigest: false }, 70)
    const a = floors(folded.prompts)
    const b = floors(plain.prompts)
    expect(a.length).toBeGreaterThan(3)
    expect(b.length).toBeGreaterThan(3)
    // Same task, same prunes: the difference is what each old call still costs.
    expect(a.at(-1)!).toBeLessThan(b.at(-1)! - 1_500)
    expect(a.at(-1)! - a[0]!).toBeLessThan((b.at(-1)! - b[0]!) * 0.6)
  })

  it("marks the oldest cleared calls and leaves the newest ones as they were", async () => {
    const { messages } = await runLoop({ pruneBudget: BUDGET, pruneKeep: KEEP, pruneDigestKeep: 4 }, 40)
    const tools = messages
      .filter((m) => m.info.role === "assistant")
      .flatMap((m) => m.parts.filter((p) => p.type === "tool")) as unknown as { metadata?: Record<string, unknown> }[]
    expect(tools[0]!.metadata?.["nikcliDigested"]).toBe(true)
    expect(tools.at(-1)!.metadata?.["nikcliDigested"]).toBeUndefined()
  })
})
