import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { ChatEvent } from "../chat/events"
import type { ServerBridge } from "../chat/transport"
import { t } from "../i18n"
import { APPROVAL_TIMEOUT_MS, withAlways } from "./approval"
import { createBotTurns } from "./controller"
import type { AgentFile } from "./nikcli"
import { admitProject } from "./project-trust"
import { appServeTurnDeps, runBotTurn, runServeTurn, type ServeClient, type ServeConnection } from "./serve-turn"
import { emptyTalk, type Talk } from "./talk"
import type { TrustStore } from "./trust"

/*
 * B8d: the panel's and a room's nikcli turns on ADE's server. A question is
 * `permission.asked` with an id, settled as B8c settles it (`approval.ts`),
 * and answered by that id: once or no, never nikcli's «always», which would
 * hold for the whole project and every bot.
 */

const SESSION = "ses_prova"
const BOT: AgentFile = {
  identifier: "alfa",
  path: "C:/finto/.config/nikcli/agent/alfa.md",
  scope: "global",
  description: "prova",
  mode: "primary",
  prompt: "Sei alfa.",
  disabledTools: [],
  runner: "nikcli",
}

function server() {
  const items: ChatEvent[] = []
  let wake: (() => void) | undefined
  const replies: [string, string][] = []
  const prompts: string[] = []
  const connects: boolean[] = []
  const client: ServeClient = {
    agents: async () => [{ name: "alfa", prompt: "Sei alfa." }],
    session: async () => undefined,
    create: async () => SESSION,
    prompt: async (input) => void prompts.push(input.text),
    abort: async () => {},
    reply: async (id, reply) => void replies.push([id, reply]),
    rejectQuestion: async () => {},
  }
  async function* read(signal: AbortSignal): AsyncGenerator<ChatEvent> {
    yield { type: "server.connected", properties: {} }
    for (;;) {
      while (items.length > 0) yield items.shift()!
      if (signal.aborted) return
      await new Promise<void>((resolve) => {
        wake = resolve
        signal.addEventListener("abort", () => resolve(), { once: true })
      })
    }
  }
  const connect = async (_directory: string, interactive: boolean): Promise<ServeConnection> => {
    connects.push(interactive)
    return { ok: true, client, events: read }
  }
  return {
    deps: { connect },
    replies,
    prompts,
    connects,
    push: (...events: ChatEvent[]) => {
      items.push(...events)
      wake?.()
    },
  }
}

const status = (type: string): ChatEvent => ({ type: "session.status", properties: { sessionID: SESSION, status: { type } } })
const asked = (id: string, command: string): ChatEvent => ({
  type: "permission.asked",
  properties: { id, sessionID: SESSION, permission: "bash", patterns: [command], metadata: {}, always: [] },
})

/** Lets the turn's promises and the stream run until `done` holds. */
async function until(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 0))
  expect(done()).toBe(true)
}

function panel(fake: ReturnType<typeof server>) {
  const talks: Record<string, Talk> = {}
  const kept: Record<string, string[]> = {}
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = []
  const turns = createBotTurns({
    runTurn: (request) => runServeTurn(request, fake.deps),
    talkOf: (path) => talks[path] ?? emptyTalk(),
    update: (path, change) => {
      talks[path] = change(talks[path] ?? emptyTalk())
    },
    always: {
      get: (path) => kept[path] ?? [],
      add: (path, key) => void (kept[path] = withAlways(kept[path] ?? [], key)),
    },
    schedule: (run, ms) => {
      const timer = { run, ms, cancelled: false }
      timers.push(timer)
      return () => void (timer.cancelled = true)
    },
  })
  return { turns, talks, kept, timers, talk: (path = BOT.path) => talks[path] ?? emptyTalk() }
}

describe("B8d: nikcli's questions in the panel and a room, by their id", () => {
  test("blocked, everyday, dangerous: settled as before, answered by id, never «always» to nikcli", async () => {
    const fake = server()
    const view = panel(fake)
    expect(view.turns.send(BOT, "ciao", "C:/progetto")).toBe(true)
    await until(() => fake.prompts.length === 1)
    expect(fake.connects).toEqual([true])

    fake.push(status("busy"), asked("per_1", "rm -rf ~"))
    await until(() => fake.replies.length === 1)
    expect(fake.replies[0]).toEqual(["per_1", "reject"])
    expect(view.talk().messages.some((message) => message.role === "error" && message.text.includes("rm -rf ~"))).toBe(true)

    fake.push(asked("per_2", "git status"))
    await until(() => fake.replies.length === 2)
    expect(fake.replies[1]).toEqual(["per_2", "once"])

    fake.push(asked("per_3", "git push --force"))
    await until(() => view.talk().permission?.requestID === "per_3")
    expect(view.talk().status).toBe("waiting")
    expect(view.talk().permission?.reason).toBeTruthy()
    expect(fake.replies.length).toBe(2)
    view.turns.answer(BOT, "always")
    await until(() => fake.replies.length === 3)
    expect(fake.replies[2]).toEqual(["per_3", "once"])
    expect(view.kept[BOT.path]?.length).toBeGreaterThan(0)
    expect(view.talk().permission).toBeUndefined()

    // The bot's «Sempre» now covers it: no question.
    fake.push(asked("per_4", "git push --force"))
    await until(() => fake.replies.length === 4)
    expect(fake.replies[3]).toEqual(["per_4", "once"])

    fake.push(status("idle"))
    await until(() => !view.turns.running(BOT.path))
    expect(view.talk().status).toBe("idle")
    expect(fake.replies.every(([, reply]) => reply !== "always")).toBe(true)
  })

  test("no answer in time is a Nega, by the question's id", async () => {
    const fake = server()
    const view = panel(fake)
    view.turns.send(BOT, "ciao", "C:/progetto")
    await until(() => fake.prompts.length === 1)
    fake.push(status("busy"), asked("per_9", "git push --force"))
    await until(() => view.talk().permission?.requestID === "per_9")
    const expiry = view.timers.find((timer) => timer.ms === APPROVAL_TIMEOUT_MS && !timer.cancelled)!
    expiry.run()
    await until(() => fake.replies.length === 1)
    expect(fake.replies[0]).toEqual(["per_9", "reject"])
    expect(view.talk().messages.at(-1)?.text).toBe(t("bots.approval.expired", "git push --force"))
    view.turns.stop(BOT)
  })

  test("a room's member: the question in the room's thread, not in the bot's", async () => {
    const fake = server()
    const view = panel(fake)
    const thread = `room:uno:${BOT.path}`
    expect(view.turns.room(BOT, "ciao", thread, "C:/progetto")).toBeDefined()
    await until(() => fake.prompts.length === 1)
    expect(fake.connects).toEqual([true])
    fake.push(status("busy"), asked("per_r", "git push --force"))
    await until(() => view.talk(thread).permission?.requestID === "per_r")
    expect(view.talk().permission).toBeUndefined()
    view.turns.answer(BOT, "reject")
    await until(() => fake.replies.length === 1)
    expect(fake.replies[0]).toEqual(["per_r", "reject"])
    view.turns.stop(BOT)
  })

  test("the panel runs nikcli on the server, the other runners as before", async () => {
    const fake = server()
    const nikcli = runBotTurn({ runner: "nikcli", bot: BOT, message: "ciao", cwd: "C:/progetto", approvals: true }, () => fake.deps)
    await until(() => fake.prompts.length === 1)
    nikcli.stop()
    await nikcli.result
    const claude = runBotTurn({ runner: "claude", message: "ciao", approvals: true }, () => fake.deps)
    claude.stop()
    await claude.result
    expect(fake.connects).toEqual([false])
  })
})

describe("B8d: the project admitted on every turn, asked about once", () => {
  const bridge = {} as ServerBridge
  function trust() {
    const saved = new Map<string, string>()
    const store: TrustStore = { get: (path) => saved.get(path), set: (path, value) => void saved.set(path, value) }
    let files = [{ path: ".nikcli/nikcli.json", text: "{}" }]
    return {
      store,
      change: () => (files = [{ path: ".nikcli/nikcli.json", text: '{"plugin":["x"]}' }]),
      of: () => ({ store, surface: async () => files }),
    }
  }

  test("the panel's dialog the first time; the next turns go through; asked again when the files change", async () => {
    const kept = trust()
    let dialogs = 0
    const deps = appServeTurnDeps(
      () => ({ bridge, admit: (directory) => admitProject(directory, { ...kept.of(), confirm: () => (dialogs++, true) }) }),
      kept.of,
    )
    for (let turn = 0; turn < 3; turn++) expect((await deps.connect("C:/progetto", true)).ok).toBe(true)
    expect(dialogs).toBe(1)
    kept.change()
    expect((await deps.connect("C:/progetto", true)).ok).toBe(true)
    expect(dialogs).toBe(2)
  })

  test("nobody in front of the screen: a project not admitted is refused, no dialog; an admitted one goes", async () => {
    const kept = trust()
    let dialogs = 0
    const deps = appServeTurnDeps(
      () => ({ bridge, admit: (directory) => admitProject(directory, { ...kept.of(), confirm: () => (dialogs++, true) }) }),
      kept.of,
    )
    const refused = await deps.connect("C:/progetto", false)
    expect(refused).toEqual({ ok: false, problem: t("bots.serve.notAdmitted", "C:/progetto") })
    expect(dialogs).toBe(0)
    expect((await deps.connect("C:/progetto", true)).ok).toBe(true)
    expect((await deps.connect("C:/progetto", false)).ok).toBe(true)
    expect(dialogs).toBe(1)
  })
})

describe("B8d: the panel says what the rules do not cover", () => {
  const bots = readFileSync(new URL("./bots.tsx", import.meta.url), "utf8")
  test("the Bot section's turns go through `runBotTurn`, and a nikcli bot's thread has the Chat's line on «always»", () => {
    expect(bots).toContain("runTurn: (request) => runBotTurn(request)")
    const thread = bots.slice(bots.indexOf('<div data-slot="bots-thread">'), bots.indexOf('<div data-slot="bots-messages"'))
    expect(thread).toContain('runnerById(props.bot.runner).id === "nikcli"')
    expect(thread).toContain('t("bots.serve.rulesNote")')
  })
})
