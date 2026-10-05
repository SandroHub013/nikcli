import { Effect } from "effect"
import { preserveTestEnv } from "../helpers/env"
import { afterAll, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "node:path"
import { removeTestDir } from "../helpers/fs"
import { runPromiseWithLayer, withCurrentInstance } from "../../src/effect"
import type { MessageV2 } from "@/session/message-v2"

/**
 * A task that runs on one user message never got its context pruned: `pruneImpl` needs two user
 * turns and only runs when the loop ends, and the window is a million tokens. `pruneLoop` clears old
 * tool outputs between steps, in blocks, once the provider-reported prompt passes a budget.
 */

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-loop-prune-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
process.env.XDG_DATA_HOME = path.join(testHome, "data")
process.env.XDG_CACHE_HOME = path.join(testHome, "cache")
process.env.XDG_CONFIG_HOME = path.join(testHome, "config")
process.env.XDG_STATE_HOME = path.join(testHome, "state")
preserveTestEnv([
  "NIKCLI_TEST_HOME",
  "NIKCLI_DISABLE_PROJECT_CONFIG",
  "NIKCLI_CONFIG_CONTENT",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
])

const { Identifier } = await import("@nikcli-ai/util/id")
const { Token } = await import("@nikcli-ai/util/token")
const { MessageV2: Message } = await import("@/session/message-v2")
const { Session } = await import("@/session")
const { SessionV2 } = await import("@/session/v2")
const { SessionCompaction } = await import("@/session/compaction")
const { isOverflow } = await import("@/session/overflow")
const { Instance } = await import("@/project/instance")

const dirs: string[] = []
afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  await removeTestDir(testHome)
})

/** Runs `fn` in a fresh project (the config is cached per instance) under the given config. */
async function inProject<T>(config: object | undefined, fn: () => Promise<T>) {
  if (config) process.env.NIKCLI_CONFIG_CONTENT = JSON.stringify(config)
  else delete process.env.NIKCLI_CONFIG_CONTENT
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-loop-prune-project-")))
  dirs.push(dir)
  return Instance.provide({ directory: dir, fn })
}

const run = <A>(effect: Effect.Effect<A, any, any>) =>
  runPromiseWithLayer(SessionCompaction.defaultLayer, withCurrentInstance(effect))
const runSession = <A>(effect: Effect.Effect<A, any, any>) =>
  runPromiseWithLayer(Session.defaultLayer, withCurrentInstance(effect))

function pruneLoop(sessionID: string) {
  return run(
    Effect.gen(function* () {
      const compaction = yield* SessionCompaction.Service
      return yield* compaction.pruneLoop({ sessionID })
    }),
  )
}

const STEP_TOKENS = 8_000
/** A tool output of about `tokens` tokens by the same estimate the prune uses. */
const output = (tokens: number) => "x".repeat(tokens * 4)

type Tool = { tool: string; input?: Record<string, unknown>; tokens?: number }

/**
 * One user message, then one assistant message per step, each with one completed tool call.
 * The last step reports `promptTokens` as its real prompt (input + cache).
 */
async function seed(sessionID: string, steps: Tool[][], promptTokens: number) {
  const user = {
    id: Identifier.ascending("message"),
    sessionID,
    role: "user" as const,
    time: { created: 1 },
    agent: "build",
    model: { providerID: "p", modelID: "m" },
  }
  SessionV2.persist({
    prepared: {
      info: user as never,
      parts: [{ id: Identifier.ascending("part"), sessionID, messageID: user.id, type: "text" as const, text: "go" }],
    },
    promptData: JSON.stringify({ sessionID, parts: [{ type: "text", text: "go" }] }),
    projectID: Instance.project.id,
  })
  const parts: string[] = []
  for (const [n, calls] of steps.entries()) {
    const last = n === steps.length - 1
    const info: MessageV2.Assistant = {
      id: Identifier.ascending("message"),
      sessionID,
      role: "assistant",
      time: { created: 2 + n, completed: 3 + n },
      parentID: user.id,
      modelID: "m",
      providerID: "p",
      mode: "build",
      agent: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: {
        input: last ? promptTokens : 1_000,
        output: 100,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      finish: "tool-calls",
    }
    await runSession(Effect.flatMap(Session.Service, (s) => s.updateMessage(info)))
    for (const [k, call] of calls.entries()) {
      const id = Identifier.ascending("part")
      parts.push(id)
      await runSession(
        Effect.flatMap(Session.Service, (s) =>
          s.updatePart({
            id,
            sessionID,
            messageID: info.id,
            type: "tool",
            callID: `call_${n}_${k}`,
            tool: call.tool,
            state: {
              status: "completed",
              input: call.input ?? { filePath: `src/file${n}_${k}.ts` },
              output: output(call.tokens ?? STEP_TOKENS),
              title: call.tool,
              metadata: {},
              time: { start: 1, end: 2 },
            },
          } as MessageV2.ToolPart),
        ),
      )
    }
  }
  return parts
}

async function toolParts(sessionID: string) {
  const out: MessageV2.ToolPart[] = []
  for await (const msg of Message.stream(sessionID)) {
    for (const part of msg.parts) if (part.type === "tool") out.push(part)
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1))
}

const compacted = (part: MessageV2.ToolPart) => part.state.status === "completed" && !!part.state.time.compacted
const live = (parts: MessageV2.ToolPart[]) =>
  parts.reduce((sum, p) => sum + (p.state.status === "completed" && !compacted(p) ? Token.estimate(p.state.output) : 0), 0)

const readStep = (): Tool[] => [{ tool: "read" }]
const steps = (n: number) => Array.from({ length: n }, readStep)

describe("SessionCompaction.pruneLoop", () => {
  it("clears the oldest outputs once the last prompt passes the budget, and keeps the rest small", async () => {
    await inProject(undefined, async () => {
      const session = await SessionV2.create({})
      await seed(session.id, steps(14), 130_000)
      const before = live(await toolParts(session.id))
      expect(before).toBeGreaterThan(100_000)

      expect(await pruneLoop(session.id)).toBeGreaterThan(0)

      const parts = await toolParts(session.id)
      expect(compacted(parts[0])).toBe(true)
      // The last step's output is untouched, and what is left is the keep target plus, at most,
      // the output that straddles it and the last step.
      expect(compacted(parts.at(-1)!)).toBe(false)
      expect(live(parts)).toBeLessThanOrEqual(24_000 + 2 * STEP_TOKENS)
      expect(live(parts)).toBeLessThan(before / 2)
    })
  })

  it("does nothing while the prompt is under the budget", async () => {
    await inProject(undefined, async () => {
      const session = await SessionV2.create({})
      await seed(session.id, steps(14), 60_000)
      expect(await pruneLoop(session.id)).toBe(0)
      expect((await toolParts(session.id)).some(compacted)).toBe(false)
    })
  })

  it("does not prune again until the prompt passes the budget again, and never for a small gain", async () => {
    await inProject(undefined, async () => {
      const session = await SessionV2.create({})
      await seed(session.id, steps(14), 130_000)
      expect(await pruneLoop(session.id)).toBeGreaterThan(0)
      const afterFirst = (await toolParts(session.id)).filter(compacted).length

      // Same prompt size reported, nothing new to free: the next step must not prune again.
      expect(await pruneLoop(session.id)).toBe(0)
      expect((await toolParts(session.id)).filter(compacted).length).toBe(afterFirst)
    })
  })

  it("waits until half a budget can be freed at once", async () => {
    await inProject(undefined, async () => {
      const session = await SessionV2.create({})
      // Over the budget, but only ~8k tokens sit beyond the protected 24k + last step.
      await seed(session.id, steps(6), 90_000)
      expect(await pruneLoop(session.id)).toBe(0)
      expect((await toolParts(session.id)).some(compacted)).toBe(false)
    })
  })

  it("leaves skill outputs and the newest todo output, but clears older todo outputs", async () => {
    await inProject(undefined, async () => {
      const session = await SessionV2.create({})
      const plan: Tool[][] = [
        [{ tool: "skill", input: { name: "s" } }],
        [{ tool: "todowrite", input: { todos: [] }, tokens: 500 }],
        ...steps(6),
        [{ tool: "todowrite", input: { todos: [] }, tokens: 500 }],
        ...steps(8),
      ]
      await seed(session.id, plan, 130_000)
      expect(await pruneLoop(session.id)).toBeGreaterThan(0)
      const parts = await toolParts(session.id)
      const by = (tool: string) => parts.filter((p) => p.tool === tool)
      expect(compacted(by("skill")[0])).toBe(false)
      const todos = by("todowrite")
      expect(compacted(todos[0])).toBe(true)
      expect(compacted(todos[1])).toBe(false)
    })
  })

  it("honours pruneBudget and pruneKeep from the config", async () => {
    await inProject({ compaction: { pruneBudget: 20_000, pruneKeep: 8_000 } }, async () => {
      const session = await SessionV2.create({})
      await seed(session.id, steps(8), 30_000)
      expect(await pruneLoop(session.id)).toBeGreaterThan(0)
      // Keep 8k: the last step, plus the one that straddles the target.
      expect(live(await toolParts(session.id))).toBeLessThanOrEqual(8_000 + 2 * STEP_TOKENS)
    })
  })

  it("is switched off by compaction.prune = false", async () => {
    await inProject({ compaction: { prune: false } }, async () => {
      const session = await SessionV2.create({})
      await seed(session.id, steps(14), 130_000)
      expect(await pruneLoop(session.id)).toBe(0)
      expect((await toolParts(session.id)).some(compacted)).toBe(false)
    })
  })
})

describe("what the model sees in place of a cleared output", () => {
  it("names the call and says it can be redone", () => {
    expect(Message.compactedNotice({ tool: "read", state: { input: { filePath: "src/a.ts" } } })).toBe(
      "[Output of read(src/a.ts) cleared to save context. Call it again if you need it.]",
    )
    expect(Message.compactedNotice({ tool: "bash", state: { input: { command: "ls  -la\n/tmp" } } })).toContain(
      "bash(ls -la /tmp)",
    )
    expect(Message.compactedNotice({ tool: "grep", state: { input: { pattern: "p".repeat(200) } } })).toContain("...)")
  })

  it("falls back to the tool name when there is no usable argument", () => {
    expect(Message.compactedNotice({ tool: "todoread", state: { input: {} } })).toBe(
      "[Output of todoread cleared to save context. Call it again if you need it.]",
    )
  })

  it("is what toModelMessages puts where the output was", () => {
    const part = {
      id: "prt_1",
      sessionID: "ses_1",
      messageID: "msg_2",
      type: "tool",
      callID: "call_1",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "src/a.ts" },
        output: "SECRET FILE CONTENT",
        title: "read",
        metadata: {},
        time: { start: 1, end: 2, compacted: 3 },
      },
    }
    const msgs = [
      {
        info: { id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "p", modelID: "m" } },
        parts: [{ id: "prt_0", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "go" }],
      },
      {
        info: {
          id: "msg_2", sessionID: "ses_1", role: "assistant", time: { created: 2, completed: 3 }, parentID: "msg_1",
          modelID: "m", providerID: "p", mode: "build", agent: "build", path: { cwd: "/", root: "/" }, cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "tool-calls",
        },
        parts: [part],
      },
    ] as unknown as MessageV2.WithParts[]
    const model = { providerID: "p", id: "m", api: { id: "m", npm: "@ai-sdk/openai" }, capabilities: {} } as never
    const json = JSON.stringify(Message.toModelMessages(msgs, model))
    expect(json).toContain("Output of read(src/a.ts) cleared to save context")
    expect(json).not.toContain("SECRET FILE CONTENT")
  })
})

describe("compaction.threshold", () => {
  const model = { limit: { context: 1_050_000, output: 128_000 }, api: { id: "m", npm: "@ai-sdk/openai" } } as never
  const tokens = (input: number) => ({ input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

  it("is off by default: a 200k prompt in a 1M window is not an overflow", () => {
    expect(isOverflow({ cfg: {} as never, tokens: tokens(200_000), model })).toBe(false)
  })

  it("triggers compaction ahead of the window when set", () => {
    const cfg = { compaction: { threshold: 150_000 } } as never
    expect(isOverflow({ cfg, tokens: tokens(200_000), model })).toBe(true)
    expect(isOverflow({ cfg, tokens: tokens(100_000), model })).toBe(false)
  })

  it("still yields to compaction.auto = false", () => {
    const cfg = { compaction: { threshold: 150_000, auto: false } } as never
    expect(isOverflow({ cfg, tokens: tokens(200_000), model })).toBe(false)
  })
})

describe("replayed reasoning of a cleared step", () => {
  const details = { openrouter: { reasoning_details: [{ type: "reasoning.encrypted", data: "ENCRYPTED-BLOB" }] } }
  function history(cleared: boolean) {
    const mark = cleared ? { [Message.REPLAY_CLEARED]: true } : {}
    return [
      {
        info: { id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "p", modelID: "m" } },
        parts: [{ id: "prt_0", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "go" }],
      },
      {
        info: {
          id: "msg_2", sessionID: "ses_1", role: "assistant", time: { created: 2, completed: 3 }, parentID: "msg_1",
          modelID: "m", providerID: "p", mode: "build", agent: "build", path: { cwd: "/", root: "/" }, cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "tool-calls",
        },
        parts: [
          { id: "prt_1", sessionID: "ses_1", messageID: "msg_2", type: "reasoning", text: "SUMMARY-TEXT", time: { start: 1, end: 2 }, metadata: { ...details, ...mark } },
          {
            id: "prt_2", sessionID: "ses_1", messageID: "msg_2", type: "tool", callID: "call_1", tool: "bash",
            state: { status: "completed", input: { command: "ls" }, output: "OUT", title: "bash", metadata: {}, time: { start: 1, end: 2 } },
            metadata: { ...details, ...mark },
          },
        ],
      },
    ] as unknown as MessageV2.WithParts[]
  }
  const model = { providerID: "p", id: "m", api: { id: "m", npm: "@ai-sdk/openai" }, capabilities: {} } as never

  it("is sent as before while the step is live", () => {
    const json = JSON.stringify(Message.toModelMessages(history(false), model))
    expect(json).toContain("SUMMARY-TEXT")
    expect(json).toContain("ENCRYPTED-BLOB")
  })

  it("is left out of the prompt once the step is marked, tool call and output line intact", () => {
    const json = JSON.stringify(Message.toModelMessages(history(true), model))
    expect(json).not.toContain("SUMMARY-TEXT")
    expect(json).not.toContain("ENCRYPTED-BLOB")
    expect(json).toContain("bash")
    expect(json).toContain("OUT")
  })
})

describe("the digest of old cleared calls", () => {
  const call = (n: number, digested: boolean) => ({
    id: `prt_c${n}`, sessionID: "ses_1", messageID: `msg_a${n}`, type: "tool", callID: `call_${n}`, tool: "bash",
    state: {
      status: "completed", input: { command: `arc3 act ACTION6 ${n} ${n}`, workdir: "C:/very/long/work/dir" },
      output: "OUT", title: "bash", metadata: {}, time: { start: 1, end: 2, compacted: 3 },
    },
    metadata: { [Message.REPLAY_CLEARED]: true, ...(digested ? { [Message.DIGESTED]: true } : {}) },
  })
  const step = (n: number, digested: boolean) => ({
    info: {
      id: `msg_a${n}`, sessionID: "ses_1", role: "assistant", time: { created: 2 + n, completed: 3 + n }, parentID: "msg_u",
      modelID: "m", providerID: "p", mode: "build", agent: "build", path: { cwd: "/", root: "/" }, cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "tool-calls",
    },
    parts: [call(n, digested)],
  })
  const user = {
    info: { id: "msg_u", sessionID: "ses_1", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "p", modelID: "m" } },
    parts: [{ id: "prt_0", sessionID: "ses_1", messageID: "msg_u", type: "text", text: "go" }],
  }
  const model = { providerID: "p", id: "m", api: { id: "m", npm: "@ai-sdk/openai" }, capabilities: {} } as never

  it("turns folded calls into one line each in one message, and leaves the others as calls", () => {
    const msgs = [user, step(1, true), step(2, true), step(3, false)] as unknown as MessageV2.WithParts[]
    const out = Message.toModelMessages(msgs, model)
    const json = JSON.stringify(out)
    expect(json).toContain("Earlier tool calls in this task")
    expect(json).toContain("- bash: arc3 act ACTION6 1 1")
    expect(json).toContain("- bash: arc3 act ACTION6 2 2")
    // Folded calls carry no call id, no working directory and no notice.
    expect(json).not.toContain("call_1")
    expect(json).not.toContain("call_2")
    expect(json.match(/C:\/very\/long\/work\/dir/g)).toHaveLength(1) // only the unfolded call's
    expect(json.match(/Earlier tool calls in this task/g)).toHaveLength(1)
    // The unfolded one is still a call with its notice, and every call has its result (no dangling pair).
    expect(json).toContain("call_3")
    expect(json).toContain("cleared to save context")
    expect(out.filter((m) => m.role === "tool")).toHaveLength(1)
  })

  it("does nothing when no call is folded", () => {
    const json = JSON.stringify(Message.toModelMessages([user, step(1, false)] as unknown as MessageV2.WithParts[], model))
    expect(json).not.toContain("Earlier tool calls")
  })
})

describe("an empty tool output", () => {
  function modelJson(output: string) {
    const part = {
      id: "prt_1", sessionID: "ses_1", messageID: "msg_2", type: "tool", callID: "call_1", tool: "bash",
      state: { status: "completed", input: { command: "true" }, output, title: "bash", metadata: {}, time: { start: 1, end: 2 } },
    }
    const msgs = [
      {
        info: { id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "p", modelID: "m" } },
        parts: [{ id: "prt_0", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "go" }],
      },
      {
        info: {
          id: "msg_2", sessionID: "ses_1", role: "assistant", time: { created: 2, completed: 3 }, parentID: "msg_1",
          modelID: "m", providerID: "p", mode: "build", agent: "build", path: { cwd: "/", root: "/" }, cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "tool-calls",
        },
        parts: [part],
      },
    ] as unknown as MessageV2.WithParts[]
    const model = { providerID: "p", id: "m", api: { id: "m", npm: "@ai-sdk/openai" }, capabilities: {} } as never
    return JSON.stringify(Message.toModelMessages(msgs, model))
  }

  it("is sent as '(no output)', because Cohere answers 400 to an empty tool result", () => {
    expect(modelJson("")).toContain("(no output)")
    expect(modelJson("  \n")).toContain("(no output)")
  })

  it("leaves a real output alone", () => {
    const json = modelJson("hello")
    expect(json).toContain("hello")
    expect(json).not.toContain("(no output)")
  })
})
