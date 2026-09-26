import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { ChatEvent } from "../chat/events"
import type { ServerBridge } from "../chat/transport"
import { t } from "../i18n"
import { APPROVAL_TIMEOUT_MS, withAlways } from "./approval"
import { createBotTurns } from "./controller"
import type { AgentFile } from "./nikcli"
import { admitProject } from "./project-trust"
import { runRoutine } from "./routine"
import { botPermission } from "./serve-rules"
import { permissionAnswerer } from "./gateway/approval"
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
  const created: (readonly unknown[])[] = []
  const client: ServeClient = {
    agents: async () => [{ name: "alfa", prompt: "Sei alfa." }],
    catalog: async () => ({}),
    session: async () => undefined,
    create: async (input) => (created.push(input.permission), SESSION),
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
    created,
    push: (...events: ChatEvent[]) => {
      items.push(...events)
      wake?.()
    },
  }
}

const status = (type: string): ChatEvent => ({ type: "session.status", properties: { sessionID: SESSION, status: { type } } })
const asked = (id: string, command: string, permission = "bash"): ChatEvent => ({
  type: "permission.asked",
  properties: { id, sessionID: SESSION, permission, patterns: [command], metadata: {}, always: [] },
})

/** Lets the turn's promises and the stream run until `done` holds. */
async function until(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 0))
  expect(done()).toBe(true)
}

/** The panel, each bot's turns on its own server (`serverOf`), or all on `fake`. */
function panel(fake: ReturnType<typeof server>, serverOf: (path: string) => ReturnType<typeof server> = () => fake) {
  const talks: Record<string, Talk> = {}
  const kept: Record<string, string[]> = {}
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = []
  const turns = createBotTurns({
    runTurn: (request) => runServeTurn(request, serverOf(request.bot?.path ?? "").deps),
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
    view.turns.answer(BOT, "always", "per_3")
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
    view.turns.answer(BOT, "reject", "per_r")
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

/*
 * B8c's approvals in the panel, as they were with the menu (`controller.ts`),
 * now answered by id: what each answer sends, what «Sempre» keeps, and when
 * a question becomes a Nega.
 */
describe("B8d: the panel's approvals, as B8c gave them", () => {
  async function started(fake: ReturnType<typeof server>, view: ReturnType<typeof panel>, bot: AgentFile = BOT) {
    view.turns.send(bot, "ciao", "C:/progetto")
    await until(() => fake.prompts.length === 1)
    fake.push(status("busy"))
  }

  test("with no question on screen an answer goes nowhere", async () => {
    const fake = server()
    const view = panel(fake)
    await started(fake, view)
    fake.push(asked("per_1", "git push --force"))
    await until(() => view.talk().permission?.requestID === "per_1")
    view.turns.answer(BOT, "once", "per_1")
    view.turns.answer(BOT, "once", "per_1")
    await until(() => fake.replies.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fake.replies).toEqual([["per_1", "once"]])
    view.turns.stop(BOT)
  })

  /* B8c review, M3: every danger of the command, not the first. */
  test("«Sempre» on the deletion does not let a forced push through with it; «Sempre» then keeps both", async () => {
    const fake = server()
    const view = panel(fake)
    view.kept[BOT.path] = ["recursiveDelete"]
    await started(fake, view)
    fake.push(asked("per_1", "rm -rf build && git push --force"))
    await until(() => view.talk().permission?.requestID === "per_1")
    expect(view.talk().permission).toMatchObject({ always: ["recursiveDelete", "gitRewrite"] })
    expect(fake.replies).toEqual([])
    view.turns.answer(BOT, "always", "per_1")
    await until(() => fake.replies.length === 1)
    expect(fake.replies[0]).toEqual(["per_1", "once"])
    expect(view.kept[BOT.path]).toEqual(["recursiveDelete", "gitRewrite"])
    fake.push(asked("per_2", "rm -rf dist && git push -f"))
    await until(() => fake.replies.length === 2)
    expect(fake.replies[1]).toEqual(["per_2", "once"])
    view.turns.stop(BOT)
  })

  test("a blocked command never runs, whatever the bot's «Sempre» holds", async () => {
    const fake = server()
    const view = panel(fake)
    view.kept[BOT.path] = ["recursiveDelete", "deleteRoot", "disk", "power"]
    await started(fake, view)
    fake.push(asked("per_1", "rm -rf /"))
    await until(() => fake.replies.length === 1)
    expect(fake.replies[0]).toEqual(["per_1", "reject"])
    expect(view.talk().permission).toBeUndefined()
    expect(view.talk().messages.at(-1)).toMatchObject({ role: "error" })
    expect(view.talk().messages.at(-1)!.text).toContain("rm -rf /")
    view.turns.stop(BOT)
  })

  test("a dangerous command waits with its reason; «Sempre» holds for this bot and not for another", async () => {
    const first = server()
    const second = server()
    const other: AgentFile = { ...BOT, path: "C:/finto/.config/nikcli/agent/altro/alfa.md" }
    const view = panel(first, (path) => (path === other.path ? second : first))
    await started(first, view)
    first.push(asked("per_1", "git push --force origin main"))
    await until(() => view.talk().permission?.requestID === "per_1")
    const waiting = view.talk().permission!
    expect(waiting).toMatchObject({ always: ["gitRewrite"] })
    expect(waiting.reason).toBeTruthy()
    expect(waiting.expiresAt! - waiting.askedAt).toBe(APPROVAL_TIMEOUT_MS)
    view.turns.answer(BOT, "always", "per_1")
    await until(() => first.replies.length === 1)
    // ADE's «Sempre», sent to nikcli as a once: never nikcli's own «always».
    expect(first.replies[0]).toEqual(["per_1", "once"])
    expect(view.kept[BOT.path]).toEqual(["gitRewrite"])
    first.push(asked("per_2", "git push -f"))
    await until(() => first.replies.length === 2)
    expect(first.replies[1]).toEqual(["per_2", "once"])

    await started(second, view, other)
    second.push(asked("per_3", "git push -f"))
    await until(() => view.talk(other.path).permission?.requestID === "per_3")
    expect(view.talk(other.path).permission).toMatchObject({ always: ["gitRewrite"] })
    view.turns.answer(other, "reject", "per_3")
    await until(() => second.replies.length === 1)
    expect(second.replies[0]).toEqual(["per_3", "reject"])
    expect(view.kept[other.path]).toBeUndefined()
    view.turns.stop(BOT)
    view.turns.stop(other)
  })

  test("a folder outside the project: kept by «Sempre» as that folder; no answer in time is a Nega", async () => {
    const fake = server()
    const view = panel(fake)
    await started(fake, view)
    fake.push(asked("per_1", "C:/Users/me/*", "external_directory"))
    await until(() => view.talk().permission?.requestID === "per_1")
    expect(view.talk().permission).toMatchObject({ always: ["outside:C:/Users/me/*"] })
    const timer = view.timers.at(-1)!
    expect(timer.ms).toBe(APPROVAL_TIMEOUT_MS)
    timer.run()
    await until(() => fake.replies.length === 1)
    expect(fake.replies[0]).toEqual(["per_1", "reject"])
    expect(view.talk().permission).toBeUndefined()
    expect(view.talk().messages.at(-1)!.text).toContain("C:/Users/me/*")
    view.turns.stop(BOT)
  })

  test("an answer in time cancels the Nega", async () => {
    const fake = server()
    const view = panel(fake)
    await started(fake, view)
    fake.push(asked("per_1", "rm -rf build"))
    await until(() => view.talk().permission?.requestID === "per_1")
    view.turns.answer(BOT, "once", "per_1")
    expect(view.timers.at(-1)!.cancelled).toBe(true)
    view.turns.stop(BOT)
  })

  test("a room's turn: its own thread, one turn at a time per bot, and the bot's thread back after it", async () => {
    const fake = server()
    const view = panel(fake)
    const thread = `room:r1:${BOT.path}`
    const turn = view.turns.room(BOT, "tocca a te", thread, "C:/progetto")
    expect(turn).toBeDefined()
    await until(() => fake.prompts.length === 1)
    expect(view.turns.threadOf(BOT.path)).toBe(thread)
    expect(view.talk(thread).messages.map((message) => message.role)).toEqual(["user"])
    expect(view.talk().messages).toEqual([])
    expect(view.turns.send(BOT, "a mano", "C:/progetto")).toBe(false)
    fake.push(status("busy"), asked("per_1", "rm -rf ~"))
    await until(() => fake.replies.length === 1)
    expect(fake.replies[0]).toEqual(["per_1", "reject"])
    fake.push(status("idle"))
    await turn!.result
    await until(() => !view.turns.running(BOT.path))
    expect(view.turns.threadOf(BOT.path)).toBe(BOT.path)
  })
})

/*
 * B8d review, M1: an answer goes to the question it was given for. A question
 * the server settles meanwhile is replaced on screen by the next one; a click
 * or a phone's «Sì» given to the first must not approve the second.
 */
describe("B8d: an answer is for its own question only", () => {
  const replied = (id: string): ChatEvent => ({ type: "permission.replied", properties: { sessionID: SESSION, requestID: id, reply: "reject" } })

  for (const where of ["panel", "room"] as const) {
    test(`${where === "panel" ? "the panel" : "a room"}: a click on the card of a question settled meanwhile does not answer the next one`, async () => {
      const fake = server()
      const view = panel(fake)
      const thread = where === "room" ? `room:r1:${BOT.path}` : BOT.path
      if (where === "room") view.turns.room(BOT, "tocca a te", thread, "C:/progetto")
      else view.turns.send(BOT, "ciao", "C:/progetto")
      await until(() => fake.prompts.length === 1)
      fake.push(status("busy"), asked("per_A", "git push --force"), asked("per_B", "git push -f origin main"))
      await until(() => view.talk(thread).permission?.requestID === "per_A")
      fake.push(replied("per_A"))
      await until(() => view.talk(thread).permission?.requestID === "per_B")
      // The click was on A's card.
      view.turns.answer(BOT, "once", "per_A")
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(fake.replies).toEqual([])
      expect(view.talk(thread).permission?.requestID).toBe("per_B")
      view.turns.answer(BOT, "reject", "per_B")
      await until(() => fake.replies.length === 1)
      expect(fake.replies).toEqual([["per_B", "reject"]])
      view.turns.stop(BOT)
    })
  }

  test("the phone: a «Sì» to a question settled meanwhile does not approve the next one", async () => {
    const fake = server()
    const phone: { question: string; answer: (value: string | undefined) => void }[] = []
    let turn: ReturnType<typeof runServeTurn> | undefined
    const ended = new AbortController()
    const onPermission = permissionAnswerer({
      ask: (question) => new Promise((resolve) => phone.push({ question, answer: resolve })),
      refuse: false,
      answer: (id, reply) => {
        if (id !== undefined) turn?.answer?.(id, reply)
      },
      say: () => {},
      signal: ended.signal,
    })
    turn = runServeTurn(
      { runner: "nikcli", bot: BOT, message: "ciao", cwd: "C:/progetto", remote: { commands: true }, onPermission },
      fake.deps,
    )
    await until(() => fake.prompts.length === 1)
    fake.push(status("busy"), asked("per_A", "git push --force"), asked("per_B", "npm publish"))
    await until(() => phone.length === 1)
    fake.push(replied("per_A"))
    await until(() => phone.length === 2)
    expect(phone[1]!.question).toContain("npm publish")
    phone[0]!.answer("once")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fake.replies).toEqual([])
    phone[1]!.answer("reject")
    await until(() => fake.replies.length === 1)
    expect(fake.replies).toEqual([["per_B", "reject"]])
    ended.abort()
    turn.stop()
    await turn.result
  })
})

describe("B8d: a routine's run and a chat's turn on the server", () => {
  test("a routine: read-only rules, no dialog, a question refused at once, the panel's session left as it was", async () => {
    const fake = server()
    const talks: Record<string, Talk> = { [BOT.path]: { ...emptyTalk(), sessionId: "ses_panel" } }
    const turns = createBotTurns({
      runTurn: () => {
        throw new Error("a routine goes through runRoutine")
      },
      runRoutine: (request, run) => runRoutine(request, run, { serve: () => fake.deps }),
      talkOf: (path) => talks[path] ?? emptyTalk(),
      update: (path, change) => {
        talks[path] = change(talks[path] ?? emptyTalk())
      },
      always: { get: () => [], add: () => {} },
    })
    const free = { ...BOT, model: "openrouter/qwen/qwen3:free" }
    expect(turns.routine(free, "controlla i log", "C:/progetto", { free: true, maxCostUsd: 0 })).toBeDefined()
    await until(() => fake.prompts.length === 1)
    expect(fake.connects).toEqual([false])
    expect(fake.created).toEqual([botPermission("read-only")])
    fake.push(status("busy"), asked("per_r", "ls"))
    await until(() => fake.replies.length === 1)
    expect(fake.replies[0]).toEqual(["per_r", "reject"])
    expect(talks[BOT.path]!.messages.some((message) => message.text === t("bots.routine.refused", "bash", "ls"))).toBe(true)
    fake.push(status("idle"))
    await until(() => !turns.running(BOT.path))
    expect(talks[BOT.path]!.sessionId).toBe("ses_panel")
    // Marked in the thread as a routine's, and nothing waits on its question.
    expect(talks[BOT.path]!.messages.some((message) => message.text === t("bots.routine.thread"))).toBe(true)
    expect(talks[BOT.path]!.permission).toBeUndefined()
  })

  test("a chat's turns and a routine's go through `runBotTurn`, so nikcli's run on the server", () => {
    const bridge = readFileSync(new URL("./gateway/bridge.ts", import.meta.url), "utf8")
    expect(bridge).toContain("runTurn: (request) => runBotTurn(request)")
    const routine = readFileSync(new URL("./routine.ts", import.meta.url), "utf8")
    expect(routine).toContain("return runBotTurn(request, deps.serve, deps)")
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
