import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { CHAT_PERMISSION, type PermissionRule } from "../chat/rules"
import type { ChatEvent } from "../chat/events"
import type { NikcliClient, ProviderList } from "@nikcli-ai/sdk/client"
import { t } from "../i18n"
import type { AgentFile } from "./nikcli"
import { botPermission } from "./serve-rules"
import { agentProblem, catalogCache, modelRef, runServeTurn, serveClientOf, type ServeClient, type ServeConnection } from "./serve-turn"
import { emptyTalk, type PendingPermission, type Talk } from "./talk"
import type { TurnRequest } from "./turn"

/*
 * B8d: a nikcli bot's turn as a prompt to ADE's server. The events are the
 * server's own, recorded by the Chat (`chat/fixtures`, C2): one turn of them
 * is played back when the prompt arrives.
 */

const SESSION = "ses_f25afa61effeQf87M7wGAgcljM"

function fixture(name: string): ChatEvent[] {
  return readFileSync(new URL(`../chat/fixtures/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ChatEvent)
}

/** The events of the `index`th turn of a recording: up to and with its `session.idle`. */
function turnOf(events: readonly ChatEvent[], index: number): ChatEvent[] {
  const turns: ChatEvent[][] = [[]]
  for (const event of events) {
    turns.at(-1)!.push(event)
    if (event.type === "session.idle") turns.push([])
  }
  return turns[index]!
}

const sessionIdOf = (events: readonly ChatEvent[]) =>
  events.map((event) => (event.properties as { sessionID?: string } | undefined)?.sessionID).find((id) => typeof id === "string")!

/** A short recorded turn, and its session. */
const FIRST = turnOf(fixture("conversazione"), 0)
const FIRST_SESSION = sessionIdOf(FIRST)

/** A stream that hands out what is pushed, until closed or aborted. */
function channel() {
  const items: ChatEvent[] = []
  let wake: (() => void) | undefined
  let closed = false
  return {
    push(...events: ChatEvent[]) {
      items.push(...events)
      wake?.()
    },
    close() {
      closed = true
      wake?.()
    },
    async *read(signal: AbortSignal): AsyncGenerator<ChatEvent> {
      yield { type: "server.connected", properties: {} }
      for (;;) {
        while (items.length > 0) yield items.shift()!
        if (closed || signal.aborted) return
        await new Promise<void>((resolve) => {
          wake = resolve
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
        wake = undefined
      }
    },
  }
}

const BOT: AgentFile = {
  identifier: "alfa",
  path: "C:/finto/.config/nikcli/agent/alfa.md",
  scope: "global",
  description: "prova",
  mode: "primary",
  prompt: "Sei alfa.\nRispondi breve.",
  disabledTools: [],
  model: "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
  effort: "high",
  runner: "nikcli",
}

/** A catalog with these models, their providers connected. */
function catalogOf(...models: string[]): ProviderList {
  const all = new Map<string, Record<string, { id: string }>>()
  for (const model of models) {
    const ref = modelRef(model)!
    all.set(ref.providerID, { ...all.get(ref.providerID), [ref.modelID]: { id: ref.modelID } })
  }
  return {
    all: [...all].map(([id, models]) => ({ id, name: id, models })),
    default: {},
    connected: [...all.keys()],
  } as unknown as ProviderList
}

interface Calls {
  connect: { directory: string; interactive: boolean }[]
  created: { title: string; permission: readonly PermissionRule[] }[]
  prompts: Parameters<ServeClient["prompt"]>[0][]
  aborted: string[]
  replies: [string, string][]
  rejectedQuestions: string[]
}

function server(
  options: {
    events?: readonly ChatEvent[]
    session?: string
    existing?: Record<string, { permission?: unknown }>
    agents?: { name: string; prompt?: string; model?: { providerID: string; modelID: string } }[]
    /** The server's catalog; by default one with the bot's model on a connected OpenRouter. */
    catalog?: Awaited<ReturnType<ServeClient["catalog"]>>
    refuse?: string
    onPrompt?: (stream: ReturnType<typeof channel>) => void
  } = {},
) {
  const stream = channel()
  const calls: Calls = { connect: [], created: [], prompts: [], aborted: [], replies: [], rejectedQuestions: [] }
  const client: ServeClient = {
    agents: async () => options.agents ?? [{ name: "build", prompt: "" }, { name: "alfa", prompt: "Sei alfa.\r\nRispondi breve.\n" }],
    session: async (id) => options.existing?.[id],
    catalog: async () => options.catalog ?? { providerList: catalogOf("openrouter/nvidia/nemotron-3-super-120b-a12b:free") },
    create: async (input) => {
      calls.created.push(input)
      return options.session ?? SESSION
    },
    prompt: async (input) => {
      calls.prompts.push(input)
      if (options.onPrompt) options.onPrompt(stream)
      else stream.push(...(options.events ?? []))
    },
    abort: async (id) => void calls.aborted.push(id),
    reply: async (id, reply) => void calls.replies.push([id, reply]),
    rejectQuestion: async (id) => void calls.rejectedQuestions.push(id),
  }
  const connect = async (directory: string, interactive: boolean): Promise<ServeConnection> => {
    calls.connect.push({ directory, interactive })
    if (options.refuse !== undefined) return { ok: false, problem: options.refuse }
    return { ok: true, client, events: (signal) => stream.read(signal) }
  }
  return { calls, stream, deps: { connect, now: () => 1_000 } }
}

/** The caller's thread, kept from `onChange` as the controller will keep it. */
function thread() {
  let talk: Talk = emptyTalk()
  return {
    onChange: (change: (talk: Talk) => Talk) => {
      talk = change(talk)
    },
    get talk() {
      return talk
    },
  }
}

const busyOf = (): ChatEvent => ({ type: "session.status", properties: { sessionID: SESSION, status: { type: "busy" } } })
const askedOf = (id: string, command: string): ChatEvent => ({
  type: "permission.asked",
  properties: { id, sessionID: SESSION, permission: "bash", patterns: [command], metadata: {}, always: [] },
})

/** Lets the turn's promises and the stream run until `done` holds. */
async function settleUntil(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 0))
  expect(done()).toBe(true)
}

const panel = (extra: Partial<TurnRequest> = {}): TurnRequest => ({
  runner: "nikcli",
  bot: BOT,
  message: "ciao",
  cwd: "C:/progetto",
  approvals: true,
  interactive: true,
  ...extra,
})

describe("B8d: a bot's turn on ADE's server", () => {
  test("a recorded turn: the bot's words and tools on the thread, the user's own words left out, its tokens and model", async () => {
    const events = turnOf(fixture("conversazione"), 1)
    const fake = server({ events, session: sessionIdOf(events) })
    const mine = thread()
    const result = await runServeTurn(panel({ onChange: mine.onChange }), fake.deps).result
    expect(result.status).toBe("done")
    expect(result.exitCode).toBe(0)
    expect(result.sessionId).toBe(sessionIdOf(events))
    const said = mine.talk.messages
    expect(said.some((message) => message.role === "user")).toBe(false)
    const tools = said.filter((message) => message.role === "tool")
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.find((message) => message.tool === "bash")?.output).toContain("ciao")
    expect(said.filter((message) => message.role === "bot").length).toBeGreaterThan(0)
    // Each part once, however many times the server sent it.
    expect(new Set(said.map((message) => message.id)).size).toBe(said.length)
    expect(mine.talk.tokens).toBeGreaterThan(0)
    expect(mine.talk.pendingTurn?.model).toContain(":free")
    expect(result.text.length).toBeGreaterThan(0)
  })

  test("the prompt: the bot as agent, its model and effort, never tools or a system prompt", async () => {
    const events = turnOf(fixture("conversazione"), 0)
    const fake = server({ events, session: sessionIdOf(events) })
    await runServeTurn(panel(), fake.deps).result
    expect(fake.calls.prompts).toEqual([
      {
        sessionID: sessionIdOf(events),
        text: "ciao",
        agent: "alfa",
        model: { providerID: "openrouter", modelID: "nvidia/nemotron-3-super-120b-a12b:free" },
        variant: "high",
      },
    ])
    expect(fake.calls.connect).toEqual([{ directory: "C:/progetto", interactive: true }])
  })

  test("a new session has the profile's rules; one that has them goes on; one of `nikcli run` or the Chat starts over, said once", async () => {
    const fake = server({ events: FIRST, session: FIRST_SESSION })
    const fresh = thread()
    await runServeTurn(panel({ onChange: fresh.onChange }), fake.deps).result
    expect(fake.calls.created.map((made) => made.permission)).toEqual([botPermission("ask")])
    expect(fresh.talk.sessionId).toBe(FIRST_SESSION)
    expect(fresh.talk.messages.some((message) => message.text === t("bots.serve.newSession"))).toBe(false)

    const kept = server({
      events: FIRST.map((event) => JSON.parse(JSON.stringify(event).replaceAll(FIRST_SESSION, "ses_mine")) as ChatEvent),
      existing: { ses_mine: { permission: [{ permission: "*", pattern: "*", action: "allow" }, ...botPermission("ask")] } },
    })
    const going = thread()
    const result = await runServeTurn(panel({ sessionId: "ses_mine", onChange: going.onChange }), kept.deps).result
    expect(kept.calls.created).toEqual([])
    expect(kept.calls.prompts[0]!.sessionID).toBe("ses_mine")
    expect(result.sessionId).toBe("ses_mine")

    const olds: Record<string, { permission?: unknown }>[] = [
      {},
      { ses_old: {} },
      { ses_old: { permission: [...CHAT_PERMISSION] } },
      { ses_old: { permission: [...botPermission("no-shell")] } },
    ]
    for (const existing of olds) {
      const over = server({ events: FIRST, session: FIRST_SESSION, existing })
      const mine = thread()
      await runServeTurn(panel({ sessionId: "ses_old", onChange: mine.onChange }), over.deps).result
      expect(over.calls.created.length).toBe(1)
      expect(mine.talk.sessionId).toBe(FIRST_SESSION)
      expect(mine.talk.messages.filter((message) => message.text === t("bots.serve.newSession")).length).toBe(1)
    }
  })

  test("the profile follows the turn: without a shell, remote, a routine's (whose session stays its own)", async () => {
    const cases: [Partial<TurnRequest>, string][] = [
      [{ bot: { ...BOT, disabledTools: ["bash"] } }, "ask-outside"],
      [{ approvals: false, remote: { commands: true } }, "remote-ask"],
      [{ approvals: false, remote: { commands: false } }, "remote-none"],
      [{ approvals: false, unattended: true, interactive: false }, "read-only"],
      [{ approvals: false }, "no-shell"],
    ]
    for (const [extra, profile] of cases) {
      const fake = server({ events: FIRST, session: FIRST_SESSION })
      const mine = thread()
      await runServeTurn(panel({ ...extra, sessionId: "ses_panel", onChange: mine.onChange }), fake.deps).result
      expect([profile, fake.calls.created[0]?.permission]).toEqual([profile, botPermission(profile as never)])
      if (extra.unattended) {
        expect(mine.talk.sessionId).toBeUndefined()
        expect(mine.talk.messages.some((message) => message.text === t("bots.serve.newSession"))).toBe(false)
      }
    }
  })

  test("a project agent by the bot's name, another prompt: refused before any session or prompt", async () => {
    const fake = server({ agents: [{ name: "alfa", prompt: "Sono l'agente del progetto." }] })
    const result = await runServeTurn(panel(), fake.deps).result
    expect(result.status).toBe("error")
    expect(result.problem).toBe(t("bots.serve.agentTaken", "alfa"))
    expect(fake.calls.created).toEqual([])
    expect(fake.calls.prompts).toEqual([])

    expect(agentProblem([{ name: "build", prompt: "x" }], BOT)).toBe(t("bots.serve.noAgent", "alfa"))
    expect(agentProblem([{ name: "alfa", prompt: " Sei alfa.\r\nRispondi breve. " }], BOT)).toBeUndefined()
    expect(agentProblem([{ name: "alfa" }], BOT)).toBe(t("bots.serve.agentTaken", "alfa"))
  })

  /* A model the server does not have: nikcli 1.398 would end the turn without a word. */
  test("a model missing from the catalog is refused before any session: the bot's, else its agent's, else the configured one", async () => {
    const gone = server({ catalog: { providerList: catalogOf("openrouter/nvidia/nemotron-3.5-lightning:free") } })
    const result = await runServeTurn(panel(), gone.deps).result
    expect(result).toMatchObject({ status: "error", problem: t("bots.serve.noModel", "openrouter/nvidia/nemotron-3-super-120b-a12b:free") })
    expect(gone.calls.created).toEqual([])
    expect(gone.calls.prompts).toEqual([])

    // A provider that is not connected has no models to run.
    const unplugged = server({ catalog: { providerList: { ...catalogOf(BOT.model!), connected: [] } } })
    expect((await runServeTurn(panel(), unplugged.deps).result).problem).toBe(t("bots.serve.noModel", BOT.model!))

    const { model: _none, ...noModel } = BOT
    const agent = { name: "alfa", prompt: BOT.prompt, model: { providerID: "openrouter", modelID: "nex-agi/nex-n2.5-mini:free" } }
    const byAgent = server({ agents: [agent], catalog: { providerList: catalogOf(BOT.model!) } })
    expect((await runServeTurn(panel({ bot: noModel }), byAgent.deps).result).problem).toBe(
      t("bots.serve.noModel", "openrouter/nex-agi/nex-n2.5-mini:free"),
    )

    const byConfig = server({ catalog: { providerList: catalogOf(BOT.model!), configModel: "openrouter/nex-agi/nex-n2.5-mini:free" } })
    expect((await runServeTurn(panel({ bot: noModel }), byConfig.deps).result).problem).toBe(
      t("bots.serve.noModel", "openrouter/nex-agi/nex-n2.5-mini:free"),
    )
    expect(byConfig.calls.created).toEqual([])
  })

  test("a catalog that cannot be read, or a turn with no model named anywhere, goes: the server decides", async () => {
    const unknown = server({ events: FIRST, session: FIRST_SESSION, catalog: {} })
    expect((await runServeTurn(panel(), unknown.deps).result).status).toBe("done")
    const { model: _none, ...noModel } = BOT
    const nothing = server({ events: FIRST, session: FIRST_SESSION, catalog: { providerList: catalogOf("openrouter/x:free") } })
    expect((await runServeTurn(panel({ bot: noModel }), nothing.deps).result).status).toBe("done")
  })

  test("a bot made while the server runs: the server reads its files again, and the turn goes", async () => {
    let reloads = 0
    const fake = server({ events: FIRST, session: FIRST_SESSION })
    const connection = (await fake.deps.connect("C:/progetto", true)) as Extract<ServeConnection, { ok: true }>
    const agents = async () => (reloads === 0 ? [{ name: "build", prompt: "" }] : [{ name: "alfa", prompt: "Sei alfa.\r\nRispondi breve.\n" }])
    const connect = async () => ({ ...connection, client: { ...connection.client, agents, reload: async () => void reloads++ } })
    const result = await runServeTurn(panel(), { ...fake.deps, connect }).result
    expect(result.status).toBe("done")
    expect(reloads).toBe(1)
  })

  test("still not there after the reload, or no reload to ask for: refused, with one reload at most", async () => {
    let reloads = 0
    const fake = server({ agents: [{ name: "build", prompt: "" }] })
    const connection = (await fake.deps.connect("C:/progetto", true)) as Extract<ServeConnection, { ok: true }>
    const connect = async () => ({ ...connection, client: { ...connection.client, reload: async () => void reloads++ } })
    expect((await runServeTurn(panel(), { ...fake.deps, connect }).result).problem).toBe(t("bots.serve.noAgent", "alfa"))
    expect(reloads).toBe(1)
    expect(fake.calls.prompts).toEqual([])
    expect((await runServeTurn(panel(), server({ agents: [] }).deps).result).problem).toBe(t("bots.serve.noAgent", "alfa"))
  })

  test("a user's bot where the project has an agent file of its name, even with the same words: refused", async () => {
    const asked: [string, string][] = []
    const fake = server()
    const projectHasAgent = async (directory: string, identifier: string) => (asked.push([directory, identifier]), true)
    const result = await runServeTurn(panel(), { ...fake.deps, projectHasAgent }).result
    expect(result.problem).toBe(t("bots.serve.agentTaken", "alfa"))
    expect(asked).toEqual([["C:/progetto", "alfa"]])
    expect(fake.calls.created).toEqual([])
    expect(fake.calls.prompts).toEqual([])

    // A project's bot is that file: it runs.
    const own = server({ events: FIRST, session: FIRST_SESSION })
    const mine = await runServeTurn(panel({ bot: { ...BOT, scope: "project" } }), { ...own.deps, projectHasAgent }).result
    expect(mine.status).toBe("done")
    // No such file: the user's bot runs.
    const free = server({ events: FIRST, session: FIRST_SESSION })
    const runs = await runServeTurn(panel(), { ...free.deps, projectHasAgent: async () => false }).result
    expect(runs.status).toBe("done")
  })

  test("no folder, or a project not admitted: nothing is sent", async () => {
    const none = server()
    const noFolder = await runServeTurn(panel({ cwd: undefined }), none.deps).result
    expect(noFolder.problem).toBe(t("bots.serve.noFolder"))
    expect(none.calls.connect).toEqual([])

    const refused = server({ refuse: "no" })
    const result = await runServeTurn(panel({ interactive: false }), refused.deps).result
    expect(result).toMatchObject({ status: "error", problem: "no" })
    expect(refused.calls.connect).toEqual([{ directory: "C:/progetto", interactive: false }])
    expect(refused.calls.prompts).toEqual([])
  })

  test("a question: one at a time to the caller, answered by its id; with nobody to answer, refused and said", async () => {
    const asked = (id: string, command: string): ChatEvent => ({
      type: "permission.asked",
      properties: { id, sessionID: SESSION, permission: "bash", patterns: [command], metadata: {}, always: [] },
    })
    const status = (type: string): ChatEvent => ({ type: "session.status", properties: { sessionID: SESSION, status: { type } } })
    const seen: PendingPermission[] = []
    let turn: ReturnType<typeof runServeTurn> | undefined
    const fake = server({
      onPrompt: (stream) => stream.push(status("busy"), asked("per_1", "git push --force"), asked("per_2", "rm x")),
    })
    turn = runServeTurn(
      panel({
        onPermission: (question) => {
          seen.push(question)
          if (question.requestID === "per_1") queueMicrotask(() => turn!.answer!("per_1", "once"))
          else
            queueMicrotask(() => {
              turn!.answer!("per_2", "reject")
              fake.stream.push(status("idle"))
            })
        },
      }),
      fake.deps,
    )
    const result = await turn.result
    expect(seen.map((question) => [question.requestID, question.permission, question.patterns])).toEqual([
      ["per_1", "bash", "git push --force"],
      ["per_2", "bash", "rm x"],
    ])
    expect(fake.calls.replies).toEqual([
      ["per_1", "once"],
      ["per_2", "reject"],
    ])
    expect(result.status).toBe("done")

    // The recorded question, with no one to answer it.
    const events = turnOf(fixture("permesso"), 1)
    const alone = server({ events, session: sessionIdOf(events) })
    const mine = thread()
    await runServeTurn(panel({ approvals: false, onChange: mine.onChange }), alone.deps).result
    expect(alone.calls.replies).toEqual([["per_0da520816001IQYwLvYn7EtWvH", "reject"]])
    expect(mine.talk.messages.some((message) => message.text === t("bots.serve.refused", "bash", "mkdir prova-permesso"))).toBe(true)
  })

  /* B8d review, M1. */
  test("an answer to a question the server settled meanwhile goes nowhere, not to the one shown in its place", async () => {
    const seen: string[] = []
    const fake = server({ onPrompt: (stream) => stream.push(busyOf(), askedOf("per_A", "git push --force"), askedOf("per_B", "rm -r x")) })
    const turn = runServeTurn(panel({ onPermission: (question) => void seen.push(question.requestID!) }), fake.deps)
    await settleUntil(() => seen.length === 1)
    fake.stream.push({ type: "permission.replied", properties: { sessionID: SESSION, requestID: "per_A", reply: "reject" } })
    await settleUntil(() => seen.length === 2)
    expect(seen).toEqual(["per_A", "per_B"])
    turn.answer!("per_A", "once")
    await Promise.resolve()
    expect(fake.calls.replies).toEqual([])
    turn.answer!("per_B", "reject")
    expect(fake.calls.replies).toEqual([["per_B", "reject"]])
    fake.stream.push({ type: "session.status", properties: { sessionID: SESSION, status: { type: "idle" } } })
    expect((await turn.result).status).toBe("done")
  })

  test("the server's error ends the turn as one, with its words on the thread", async () => {
    const events = turnOf(fixture("errori"), 0)
    const fake = server({ events, session: sessionIdOf(events) })
    const mine = thread()
    const result = await runServeTurn(panel({ onChange: mine.onChange }), fake.deps).result
    expect(result.status).toBe("error")
    expect(result.exitCode).toBe(1)
    expect(result.problem).toBe("Provider returned error")
    expect(mine.talk.status).toBe("error")
    expect(mine.talk.messages.at(-1)).toMatchObject({ role: "error", text: "Provider returned error" })
  })

  test("Ferma, the time limit and the spend cap stop the turn on the server too", async () => {
    const busy: ChatEvent = { type: "session.status", properties: { sessionID: SESSION, status: { type: "busy" } } }
    const stopping = server({ onPrompt: (stream) => stream.push(busy) })
    let turn: ReturnType<typeof runServeTurn> | undefined
    turn = runServeTurn(panel({ onUpdate: () => {} }), {
      ...stopping.deps,
      connect: async (directory, interactive) => {
        const connection = await stopping.deps.connect(directory, interactive)
        if (connection.ok) {
          const prompt = connection.client.prompt
          return {
            ...connection,
            client: { ...connection.client, prompt: async (input) => (await prompt(input), setTimeout(() => turn!.stop(), 5), undefined) },
          }
        }
        return connection
      },
    })
    expect((await turn.result).status).toBe("stopped")
    await Promise.resolve()
    expect(stopping.calls.aborted).toEqual([SESSION])

    const slow = server({ onPrompt: (stream) => stream.push(busy) })
    const late = await runServeTurn(panel({ timeoutMs: 20 }), slow.deps).result
    expect(late.status).toBe("error")
    expect(late.problem).toContain("nikcli")
    await Promise.resolve()
    expect(slow.calls.aborted).toEqual([SESSION])

    const spending: ChatEvent = {
      type: "message.updated",
      properties: { info: { id: "msg_a", sessionID: SESSION, role: "assistant", cost: 0.3, tokens: { total: 10 } } },
    }
    const dear = server({ onPrompt: (stream) => stream.push(busy, spending) })
    const capped = await runServeTurn(panel({ maxCostUsd: 0.2 }), dear.deps).result
    expect(capped.status).toBe("error")
    expect(capped.problem).toBe(t("bots.turn.overBudget", "nikcli", "0.30 $", "0.20 $"))
    await Promise.resolve()
    expect(dear.calls.aborted).toEqual([SESSION])
  })

  test("another session's events are not this turn's", async () => {
    const other = turnOf(fixture("conversazione"), 1)
    const fake = server({
      onPrompt: (stream) => {
        stream.push(...other)
        stream.push(
          { type: "session.status", properties: { sessionID: "ses_mine", status: { type: "busy" } } },
          { type: "session.idle", properties: { sessionID: "ses_mine" } },
        )
      },
      session: "ses_mine",
    })
    const mine = thread()
    const result = await runServeTurn(panel({ onChange: mine.onChange }), fake.deps).result
    expect(result.status).toBe("done")
    expect(mine.talk.messages.filter((message) => message.role !== "user")).toEqual([])
  })

  test("a model is provider, then the rest", () => {
    expect(modelRef("openrouter/qwen/qwen3:free")).toEqual({ providerID: "openrouter", modelID: "qwen/qwen3:free" })
    expect(modelRef("solo")).toBeUndefined()
    expect(modelRef("/x")).toBeUndefined()
    expect(modelRef(undefined)).toBeUndefined()
  })
})

/* Modello assente review, M4: a bot's turn does not wait for ever on the catalog. */
describe("the bot's catalog read has a time limit", () => {
  test("a server that never answers gives an unknown catalog, in time", async () => {
    const never = () => new Promise<never>(() => {})
    const client = { provider: { list: never }, config: { get: never } } as unknown as NikcliClient
    const started = Date.now()
    expect(await serveClientOf(client, 20).catalog()).toEqual({})
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

/* Modello assente review, B3: the bots' catalog is kept per folder for a while. */
describe("the bots' catalog is kept", () => {
  test("read once per folder while fresh; `fresh` reads again; an unread one is not kept; old ones are read again", async () => {
    let at = 0
    const cache = catalogCache(1_000, () => at)
    let reads = 0
    const good = async () => (reads++, { providerList: catalogOf("openrouter/a/b:free") })
    await cache("C:/p", good)
    await cache("C:/p", good)
    expect(reads).toBe(1)
    await cache("C:/altro", good)
    expect(reads).toBe(2)
    await cache("C:/p", good, true)
    expect(reads).toBe(3)
    at = 1_500
    await cache("C:/p", good)
    expect(reads).toBe(4)
    let unread = 0
    const none = async () => (unread++, {})
    await cache("C:/q", none)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await cache("C:/q", none)
    expect(unread).toBe(2)
  })

  test("a turn reads the catalog again before refusing: a model connected since the last read goes", async () => {
    const fake = server({ events: FIRST, session: FIRST_SESSION })
    const reads: boolean[] = []
    const client = (await fake.deps.connect("C:/progetto", true)) as Extract<ServeConnection, { ok: true }>
    const deps = {
      ...fake.deps,
      connect: async () => ({
        ...client,
        client: {
          ...client.client,
          catalog: async (fresh?: boolean) => {
            reads.push(fresh === true)
            return { providerList: fresh ? catalogOf(BOT.model!) : catalogOf("openrouter/x/y:free") }
          },
        },
      }),
    }
    const result = await runServeTurn(panel(), deps).result
    expect(result.status).toBe("done")
    expect(reads).toEqual([false, true])
  })
})
