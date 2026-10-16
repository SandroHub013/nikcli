import { describe, expect, test } from "bun:test"
import { t, setLocalePreference } from "../../i18n"
import type { AgentFile } from "../ragu"
import { emptyTalk } from "../talk"
import type { Turn, TurnRequest, TurnResult } from "../turn"
import { chatCommand } from "./policy"
import { startGatewayController, type GatewayBridge, type GatewayMessage } from "./controller"
import { memorySessionStore } from "./session"

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
  return { fake, sent, questions, acks, emit, press }
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
