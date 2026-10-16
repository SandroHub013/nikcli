import { describe, expect, test } from "bun:test"
import { t, setLocalePreference } from "../../i18n"
import type { AgentFile } from "../ragu"
import { emptyTalk } from "../talk"
import type { Turn, TurnRequest, TurnResult } from "../turn"
import { chatCommand } from "./policy"
import { startGatewayController, type GatewayBridge, type GatewayMessage } from "./controller"
import { HISTORY_PER_CHAT, memoryHistoryStore, memorySessionStore, sessionTitle } from "./session"
import { createGatewayThreads, gatewayThreadKey, type ThreadDisk } from "./threads"
import { appendMessage, sendMessage } from "../talk"
import { botForChat, memoryChatModelStore, modelChoices, MODEL_CHOICES_MAX } from "./chat-model"

/*
 * Choice 9: the four commands a chat gained, `/riprova`, `/costo`, `/modello` and `/sessioni`, with a fake Rust side
 * and fake turns.
 */

setLocalePreference("it")

const PROJECT = "C:/progetto"
const BOT: AgentFile = {
  identifier: "aiuto",
  path: `${PROJECT}/.nikcli/agent/aiuto.md`,
  scope: "project",
  description: "",
  mode: "primary",
  prompt: "Sei utile.",
  disabledTools: [],
  runner: "claude",
}

function bridge() {
  let handler: ((message: GatewayMessage) => void) | undefined
  const sent: { chat: string; text: string }[] = []
  const questions: { chat: string; text: string; buttons: readonly { label: string; data: string }[] }[] = []
  const acks: string[] = []
  let counter = 0
  const flags = { buttonsFail: false }
  const fake: GatewayBridge = {
    listen: async (on) => {
      handler = on
      return () => void (handler = undefined)
    },
    ready: async () => {},
    ack: async (_bot, _platform, _chat, id) => void acks.push(id),
    send: async (_bot, _platform, chat, text) => {
      sent.push({ chat, text })
      return String(sent.length)
    },
    sendButtons: async (_bot, _platform, chat, text, buttons) => {
      if (flags.buttonsFail) throw new Error("niente tasti")
      questions.push({ chat, text, buttons })
      return "q"
    },
    typing: async () => {},
    project: async () => PROJECT,
  }
  const emit = (text: string, extra: Partial<GatewayMessage> = {}) =>
    handler?.({
      bot: BOT.path,
      platform: "telegram",
      chat: "c42",
      sender: { id: "42", name: "Ale" },
      text,
      id: `m${++counter}`,
      redacted: false,
      button: false,
      private: true,
      ...extra,
    })
  /** Presses a button of the last question. */
  const press = (index: number, from: Partial<GatewayMessage> = {}) => {
    const question = questions.at(-1)!
    emit(question.buttons[index]!.data, { button: true, ...from })
  }
  return { fake, sent, questions, acks, emit, press, flags }
}

function fakeTurns() {
  const started: { request: TurnRequest; finish: (result: Partial<TurnResult>) => void }[] = []
  const runTurn = (request: TurnRequest): Turn => {
    let resolve!: (result: TurnResult) => void
    const result = new Promise<TurnResult>((done) => (resolve = done))
    const entry = {
      request,
      finish: (partial: Partial<TurnResult>) =>
        resolve({ status: "done", text: "", tokens: 0, costUsd: 0, talk: emptyTalk(), ...partial }),
    }
    started.push(entry)
    return { result, stop: () => entry.finish({ status: "stopped" }) }
  }
  return { started, runTurn }
}

async function until(what: string, check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`non è successo: ${what}`)
}

const trusted = async () => ({ ok: true as const, bot: BOT })

describe("the names of the commands", () => {
  test("the four new ones are known in Italian and English, as Telegram writes them from a menu", () => {
    expect(chatCommand("/riprova")).toBe("retry")
    expect(chatCommand("/retry@MioBot")).toBe("retry")
    expect(chatCommand("/riprova adesso")).toBeUndefined()
    expect(chatCommand("/costo")).toBe("cost")
    expect(chatCommand("/cost")).toBe("cost")
    expect(chatCommand("/modello")).toBe("model")
    expect(chatCommand("/MODEL@MioBot")).toBe("model")
    expect(chatCommand("/sessioni")).toBe("sessions")
    expect(chatCommand("/sessions")).toBe("sessions")
  })
})

describe("/riprova", () => {
  test("it asks the last question again, in the same conversation, once the turn is over", async () => {
    const b = bridge()
    const turns = fakeTurns()
    await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot: trusted, sessions: memorySessionStore() })
    b.emit("fammi un riassunto", { id: "m-1" })
    await until("il turno", () => turns.started.length === 1)
    turns.started[0]!.finish({ status: "error", problem: "x", sessionId: "s-1" })
    await until("l'errore", () => b.sent.some((sent) => sent.text === t("gateway.failed")))
    b.emit("/riprova")
    await until("il secondo turno", () => turns.started.length === 2)
    expect(b.sent.some((sent) => sent.text === t("gateway.retry.again"))).toBe(true)
    // The same words, framed again, in the conversation the first turn left.
    expect(turns.started[1]!.request.message).toBe(turns.started[0]!.request.message)
    turns.started[1]!.finish({ text: "ecco", sessionId: "s-1" })
    await until("la risposta", () => b.sent.at(-1)!.text === "ecco")
    // Rust never saw the message `/riprova` made: only the real ones are acknowledged.
    expect(b.acks.filter((id) => id.includes(":retry:"))).toEqual([])
    expect(b.acks).toContain("m-1")
  })

  test("with nothing asked yet, or while a turn runs, it says so and starts nothing", async () => {
    const b = bridge()
    const turns = fakeTurns()
    await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot: trusted, sessions: memorySessionStore() })
    b.emit("/riprova")
    await until("niente da rifare", () => b.sent.at(-1)?.text === t("gateway.retry.none"))
    b.emit("una domanda")
    await until("il turno", () => turns.started.length === 1)
    b.emit("/riprova")
    await until("occupato", () => b.sent.at(-1)!.text === t("gateway.retry.busy"))
    expect(turns.started).toHaveLength(1)
    turns.started[0]!.finish({ text: "ok" })
  })

  test("whoever says it owns the new turn: the header names them", async () => {
    const b = bridge()
    const turns = fakeTurns()
    await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot: trusted, sessions: memorySessionStore() })
    b.emit("ciao", { sender: { id: "42", name: "Ale" } })
    await until("il turno", () => turns.started.length === 1)
    turns.started[0]!.finish({ text: "ok" })
    await until("la risposta", () => b.sent.at(-1)?.text === "ok")
    // Another sender of the same chat asks again: the turn is theirs (the header names them).
    b.emit("/riprova", { sender: { id: "43", name: "Bea" } })
    await until("il secondo turno", () => turns.started.length === 2)
    expect(turns.started[1]!.request.message).toContain("Bea")
    turns.started[1]!.finish({ text: "ok" })
  })
})

describe("/costo", () => {
  test("it says today's spend, even while a turn runs, and the same line /stato ends with", async () => {
    const b = bridge()
    const turns = fakeTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
      spendToday: async () => "Oggi 0,42 $ di 2,00 $.",
    })
    b.emit("una domanda")
    await until("il turno", () => turns.started.length === 1)
    b.emit("/costo")
    await until("la spesa", () => b.sent.at(-1)?.text === "Oggi 0,42 $ di 2,00 $.")
    b.emit("/stato")
    await until("lo stato", () => b.sent.at(-1)!.text.endsWith("Oggi 0,42 $ di 2,00 $."))
    expect(turns.started).toHaveLength(1)
    turns.started[0]!.finish({ text: "ok" })
  })

  test("a bot that spends no money says so, and so does one whose spend cannot be read", async () => {
    const b = bridge()
    let fail = false
    await startGatewayController({
      bridge: b.fake,
      runTurn: fakeTurns().runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
      spendToday: async () => {
        if (fail) throw new Error("illeggibile")
        return undefined
      },
    })
    b.emit("/costo")
    await until("niente da contare", () => b.sent.at(-1)?.text === t("gateway.cost.none"))
    fail = true
    b.emit("/costo")
    await until("illeggibile", () => b.sent.length === 2)
    expect(b.sent[1]!.text).toBe(t("gateway.cost.none"))
  })

  test("the help lists it, in both languages", () => {
    expect(t("gateway.help")).toContain("/costo")
    setLocalePreference("en")
    expect(t("gateway.help")).toContain("/cost ")
    setLocalePreference("it")
  })
})

describe("the models a chat may choose", () => {
  const claude: AgentFile = { ...BOT, runner: "claude" }
  const ragu: AgentFile = { ...BOT, runner: "ragu" }

  test("a bot on a CLI: its own model first, then that CLI's list, each once and no more than a phone reads", () => {
    const list = modelChoices({ ...claude, model: "sonnet" }, [])
    expect(list[0]).toBe("sonnet")
    expect(list.filter((model) => model === "sonnet")).toHaveLength(1)
    expect(list.length).toBeLessThanOrEqual(MODEL_CHOICES_MAX)
    expect(modelChoices(claude, [])[0]).toBe("fable")
    expect(modelChoices({ ...claude, runner: "codex" }, [])).toContain("gpt-5.5")
  })

  test("a ragu bot: only the free models of the catalog, and its own even if it is a paid one", () => {
    const catalog = ["openrouter/a/b:free", "anthropic/claude-opus", "openrouter/c/d:free", "openai/gpt"]
    expect(modelChoices(ragu, catalog)).toEqual(["openrouter/a/b:free", "openrouter/c/d:free"])
    expect(modelChoices({ ...ragu, model: "anthropic/claude-opus" }, catalog)).toEqual([
      "anthropic/claude-opus",
      "openrouter/a/b:free",
      "openrouter/c/d:free",
    ])
    expect(modelChoices(ragu, [])).toEqual([])
  })

  test("an id a command line could take as something else is never offered", () => {
    expect(modelChoices({ ...ragu, model: "--yolo" }, ["x y/z:free", "ok/model:free", "-rf/z:free"])).toEqual(["ok/model:free"])
  })

  test("the chat's choice holds only for the CLI it was made on", () => {
    expect(botForChat(claude, { runner: "claude", model: "opus" }).model).toBe("opus")
    expect(botForChat({ ...claude, model: "sonnet" }, { runner: "codex", model: "gpt-5.5" }).model).toBe("sonnet")
    expect(botForChat(claude, undefined)).toBe(claude)
  })

  test("a saved choice that is not an id is none", () => {
    const store = memoryChatModelStore()
    store.set("k", { runner: "claude", model: "opus" })
    expect(store.get("k")).toEqual({ runner: "claude", model: "opus" })
    store.forget("k")
    expect(store.get("k")).toBeUndefined()
  })
})

describe("/modello", () => {
  const withModels = async (extra: Partial<Parameters<typeof startGatewayController>[0]> = {}) => {
    const b = bridge()
    const turns = fakeTurns()
    const chatModels = memoryChatModelStore()
    const controller = await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
      chatModels,
      ...extra,
    })
    return { b, turns, chatModels, controller }
  }

  test("it shows the model and lets a button choose another of the bot's own, for that chat from the next message on", async () => {
    const { b, turns, chatModels } = await withModels()
    b.emit("/modello")
    await until("la lista", () => b.questions.length === 1)
    const question = b.questions[0]!
    expect(question.text).toContain(t("gateway.model.default", "Claude Code"))
    expect(question.text).toContain("1. ")
    expect(question.buttons.map((button) => button.label)[0]).toStartWith("1. ")
    b.press(2)
    await until("la conferma", () => b.sent.length === 1)
    expect(b.sent[0]!.text).toContain("sonnet")
    expect(chatModels.get(`${BOT.path}:telegram:c42`)).toEqual({ runner: "claude", model: "sonnet" })
    b.emit("ciao")
    await until("il turno", () => turns.started.length === 1)
    expect(turns.started[0]!.request.bot?.model).toBe("sonnet")
    turns.started[0]!.finish({ text: "ok" })
    // Another chat of the same bot is not touched.
    await until("risposto", () => b.sent.at(-1)!.text === "ok")
    b.emit("ciao", { chat: "c99" })
    await until("il turno dell'altra chat", () => turns.started.length === 2)
    expect(turns.started[1]!.request.bot?.model).toBeUndefined()
    turns.started[1]!.finish({ text: "ok" })
  })

  test("a number typed in the chat answers it, a number out of the list is told so and the list stays", async () => {
    const { b, chatModels } = await withModels()
    b.emit("/modello")
    await until("la lista", () => b.questions.length === 1)
    b.emit("99")
    await until("fuori elenco", () => b.sent.at(-1)?.text === t("gateway.pick.range", b.questions[0]!.buttons.length))
    expect(chatModels.get(`${BOT.path}:telegram:c42`)).toBeUndefined()
    b.emit("1")
    await until("scelto", () => chatModels.get(`${BOT.path}:telegram:c42`) !== undefined)
    expect(chatModels.get(`${BOT.path}:telegram:c42`)!.model).toBe("fable")
  })

  test("a number is a message when no list waits", async () => {
    const { b, turns } = await withModels()
    b.emit("2")
    await until("il turno", () => turns.started.length === 1)
    expect(turns.started[0]!.request.message).toContain("2")
    turns.started[0]!.finish({ text: "ok" })
  })

  test("a list is answered by the person who asked, and by no other", async () => {
    const { b, chatModels } = await withModels()
    b.emit("/modello")
    await until("la lista", () => b.questions.length === 1)
    b.press(1, { sender: { id: "43", name: "Bea" } })
    b.emit("1", { sender: { id: "43", name: "Bea" } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(chatModels.get(`${BOT.path}:telegram:c42`)).toBeUndefined()
    b.press(1)
    await until("scelto", () => chatModels.get(`${BOT.path}:telegram:c42`) !== undefined)
  })

  test("where the buttons cannot be sent, the list goes as text and the number answers it", async () => {
    const { b, chatModels } = await withModels()
    b.flags.buttonsFail = true
    b.emit("/modello")
    await until("la lista in testo", () => b.sent.length === 1)
    expect(b.sent[0]!.text).toContain("1. ")
    b.emit("2")
    await until("scelto", () => chatModels.get(`${BOT.path}:telegram:c42`) !== undefined)
    expect(chatModels.get(`${BOT.path}:telegram:c42`)!.model).toBe("opus")
  })

  test("the bot's own model goes back by choosing it, and /nuova keeps the choice", async () => {
    const own: AgentFile = { ...BOT, model: "haiku" }
    const { b, chatModels } = await withModels({ loadBot: async () => ({ ok: true as const, bot: own }) })
    chatModels.set(`${BOT.path}:telegram:c42`, { runner: "claude", model: "opus" })
    b.emit("/nuova")
    await until("nuova", () => b.sent.length === 1)
    expect(chatModels.get(`${BOT.path}:telegram:c42`)).toBeDefined()
    b.emit("/modello")
    await until("la lista", () => b.questions.length === 1)
    // The bot's own is first, and the one in use is marked.
    expect(b.questions[0]!.text).toContain(`1. haiku (${t("gateway.model.tagOwn")})`)
    expect(b.questions[0]!.text).toContain(`(${t("gateway.model.tagCurrent")})`)
    b.press(0)
    await until("tolto", () => chatModels.get(`${BOT.path}:telegram:c42`) === undefined)
  })

  test("on ragu only the free models are offered, and it says so", async () => {
    const raguBot: AgentFile = { ...BOT, runner: "ragu" }
    const { b } = await withModels({
      loadBot: async () => ({ ok: true as const, bot: raguBot }),
      modelCatalog: async () => ["openrouter/a/b:free", "anthropic/claude-opus"],
    })
    b.emit("/modello")
    await until("la lista", () => b.questions.length === 1)
    expect(b.questions[0]!.buttons).toHaveLength(1)
    expect(b.questions[0]!.text).not.toContain("claude-opus")
    expect(b.questions[0]!.text).toContain("gratuiti")
  })

  test("with nothing to offer, or no way to keep a choice, it only says the model in use", async () => {
    const raguBot: AgentFile = { ...BOT, runner: "ragu", model: "openrouter/x/y:free" }
    const empty = await withModels({
      loadBot: async () => ({ ok: true as const, bot: { ...raguBot, model: undefined } as AgentFile }),
      modelCatalog: async () => [],
    })
    empty.b.emit("/modello")
    await until("niente", () => empty.b.sent.length === 1)
    expect(empty.b.sent[0]!.text).toBe(t("gateway.model.nothing", t("gateway.model.default", "Ragu Code")))
    const bare = bridge()
    await startGatewayController({
      bridge: bare.fake,
      runTurn: fakeTurns().runTurn,
      loadBot: async () => ({ ok: true as const, bot: raguBot }),
      sessions: memorySessionStore(),
    })
    bare.emit("/modello")
    await until("solo il modello", () => bare.sent.length === 1)
    expect(bare.sent[0]!.text).toBe(t("gateway.model.only", "openrouter/x/y:free"))
  })

  test("/costo and /stato are given the chat's model, so a paid choice is counted as paid", async () => {
    const seen: (string | undefined)[] = []
    const { b, chatModels } = await withModels({
      spendToday: async (_bot, model) => {
        seen.push(model)
        return "Oggi 0,00 $."
      },
    })
    b.emit("/costo")
    await until("senza scelta", () => seen.length === 1)
    chatModels.set(`${BOT.path}:telegram:c42`, { runner: "claude", model: "opus" })
    b.emit("/costo")
    await until("con la scelta", () => seen.length === 2)
    expect(seen).toEqual([undefined, "opus"])
  })

  test("the help lists it, in both languages", () => {
    expect(t("gateway.help")).toContain("/modello")
    setLocalePreference("en")
    expect(t("gateway.help")).toContain("/model ")
    setLocalePreference("it")
  })
})

describe("/sessioni", () => {
  const KEY = `${BOT.path}:telegram:c42`
  const memoryDisk = (): ThreadDisk & { items: Map<string, string> } => {
    const items = new Map<string, string>()
    return {
      items,
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => void items.set(key, value),
      removeItem: (key) => void items.delete(key),
    }
  }
  const setup = async (extra: Partial<Parameters<typeof startGatewayController>[0]> = {}) => {
    const b = bridge()
    const turns = fakeTurns()
    const sessions = memorySessionStore()
    const history = memoryHistoryStore()
    const disk = memoryDisk()
    const threads = createGatewayThreads(disk)
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions,
      history,
      threads,
      ...extra,
    })
    /** One whole turn of the chat: the words, and the session the CLI gave. */
    const say = async (text: string, sessionId: string, chat = "c42") => {
      const before = turns.started.length
      b.emit(text, { chat })
      await until("il turno", () => turns.started.length === before + 1)
      const talk = appendMessage(sendMessage(emptyTalk(), text, 1), { role: "bot", text: `risposta a ${text}` }, 2)
      turns.started[before]!.finish({ text: `risposta a ${text}`, sessionId, talk })
      await until("la risposta", () => b.sent.at(-1)?.text === `risposta a ${text}`)
    }
    return { b, turns, sessions, history, disk, threads, say }
  }

  test("a conversation gets the first words it began with as its title, and keeps them", async () => {
    const { sessions, say } = await setup()
    await say("  \n  fammi un riassunto del progetto  ", "s-1")
    expect(sessions.get(KEY)?.title).toBe("fammi un riassunto del progetto")
    await say("e poi?", "s-1")
    expect(sessions.get(KEY)?.title).toBe("fammi un riassunto del progetto")
    expect(sessions.get(KEY)?.at).toBeGreaterThan(0)
    expect(sessionTitle("x".repeat(80))).toHaveLength(40)
    expect(sessionTitle("riga uno\nriga due")).toBe("riga uno")
  })

  test("/nuova keeps the conversation it drops, and /sessioni lists it and resumes it with its thread", async () => {
    const { b, sessions, history, threads, say, turns } = await setup()
    await say("prima conversazione", "s-1")
    b.emit("/nuova")
    await until("nuova", () => b.sent.at(-1)?.text === t("gateway.fresh"))
    expect(sessions.get(KEY)).toBeUndefined()
    expect(history.list(KEY).map((past) => past.sessionId)).toEqual(["s-1"])
    await say("seconda conversazione", "s-2")
    // The chat's thread is the second one now; the first is kept apart.
    expect(threads.read(gatewayThreadKey(BOT.path, "telegram", "c42")).messages.some((m) => m.text === "seconda conversazione")).toBe(true)
    b.emit("/sessioni")
    await until("la lista", () => b.questions.length === 1)
    expect(b.questions[0]!.text).toContain("prima conversazione")
    expect(b.questions[0]!.text).toContain("seconda conversazione")
    expect(b.questions[0]!.buttons).toHaveLength(1)
    b.press(0)
    await until("ripresa", () => b.sent.at(-1)?.text === t("gateway.sessions.resumed", "prima conversazione"))
    expect(sessions.get(KEY)?.sessionId).toBe("s-1")
    // The one it left is kept in its turn, and the thread on screen is the first one again.
    expect(history.list(KEY).map((past) => past.sessionId)).toEqual(["s-2"])
    const thread = threads.read(gatewayThreadKey(BOT.path, "telegram", "c42"))
    expect(thread.messages.some((m) => m.text === "prima conversazione")).toBe(true)
    expect(thread.messages.some((m) => m.text === "seconda conversazione")).toBe(false)
    // The next message goes on in the resumed conversation.
    b.emit("ancora")
    await until("il turno", () => turns.started.length === 3)
    expect(turns.started[2]!.request.sessionId).toBe("s-1")
    turns.started[2]!.finish({ text: "ok", sessionId: "s-1" })
  })

  test("with nothing to resume it says so; in a channel it lists nothing", async () => {
    const { b, say } = await setup()
    b.emit("/sessioni")
    await until("niente", () => b.sent.at(-1)?.text === t("gateway.sessions.none"))
    await say("una cosa", "s-1")
    b.emit("/nuova")
    await until("nuova", () => b.sent.at(-1)?.text === t("gateway.fresh"))
    b.emit("/sessioni", { private: false })
    await until("canale", () => b.sent.at(-1)?.text === t("gateway.sessions.private"))
    expect(b.questions).toHaveLength(0)
  })

  test("while a turn runs it asks to wait, and a turn that came during the choice stops it", async () => {
    const { b, turns, say } = await setup()
    await say("vecchia", "s-1")
    b.emit("/nuova")
    await until("nuova", () => b.sent.at(-1)?.text === t("gateway.fresh"))
    b.emit("lavoro lungo")
    await until("il turno", () => turns.started.length === 2)
    b.emit("/sessioni")
    await until("occupato", () => b.sent.at(-1)?.text === t("gateway.sessions.busy"))
    turns.started[1]!.finish({ text: "fatto", sessionId: "s-2" })
    await until("finito", () => b.sent.at(-1)?.text === "fatto")
    b.emit("/sessioni")
    await until("la lista", () => b.questions.length === 1)
    // A turn starts before the choice is made: resuming now would swap the conversation under it.
    b.emit("un altro lavoro")
    await until("il turno", () => turns.started.length === 3)
    b.press(0)
    await until("occupato di nuovo", () => b.sent.at(-1)?.text === t("gateway.sessions.busy"))
    turns.started[2]!.finish({ text: "ok", sessionId: "s-2" })
  })

  test("a conversation of another project or another engine is not resumed from here", async () => {
    const { b, history } = await setup()
    history.add(KEY, { project: "C:/altro", runner: "claude", sessionId: "s-9", title: "di un altro progetto", at: 1 })
    b.emit("/sessioni")
    await until("la lista", () => b.questions.length === 1)
    b.press(0)
    await until("rifiutata", () => b.sent.at(-1)?.text === t("gateway.sessions.other", "di un altro progetto"))
    expect(history.list(KEY)).toHaveLength(1)
  })

  test("only the person who asked chooses", async () => {
    const { b, history, sessions } = await setup()
    history.add(KEY, { project: PROJECT, runner: "claude", sessionId: "s-9", title: "mia", at: 1 })
    b.emit("/sessioni")
    await until("la lista", () => b.questions.length === 1)
    b.press(0, { sender: { id: "43", name: "Bea" } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sessions.get(KEY)).toBeUndefined()
    b.emit("1")
    await until("ripresa", () => sessions.get(KEY)?.sessionId === "s-9")
  })

  test("a chat keeps its last few conversations, and what is pushed out takes its thread along", async () => {
    const { b, history, disk, say } = await setup()
    for (let round = 1; round <= HISTORY_PER_CHAT + 2; round++) {
      await say(`conversazione ${round}`, `s-${round}`)
      b.emit("/nuova")
      await until("nuova", () => b.sent.at(-1)?.text === t("gateway.fresh") && b.sent.filter((s) => s.text === t("gateway.fresh")).length === round)
    }
    const kept = history.list(KEY).map((past) => past.sessionId)
    expect(kept).toHaveLength(HISTORY_PER_CHAT)
    expect(kept[0]).toBe(`s-${HISTORY_PER_CHAT + 2}`)
    expect(kept).not.toContain("s-1")
    const threadKeys = [...disk.items.keys()]
    expect(threadKeys.some((key) => key.endsWith(":s-1"))).toBe(false)
    expect(threadKeys.some((key) => key.endsWith(`:s-${HISTORY_PER_CHAT + 2}`))).toBe(true)
  })

  test("the help lists it, in both languages", () => {
    expect(t("gateway.help")).toContain("/sessioni")
    setLocalePreference("en")
    expect(t("gateway.help")).toContain("/sessions ")
    setLocalePreference("it")
  })
})
