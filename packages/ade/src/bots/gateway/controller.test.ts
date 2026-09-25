import { describe, expect, test } from "bun:test"
import { t } from "../../i18n"
import type { AgentFile } from "../nikcli"
import { emptyTalk } from "../talk"
import { turnsRunning } from "../terms"
import { runTurn, type Turn, type TurnDeps, type TurnRequest, type TurnResult } from "../turn"
import { startGatewayController, type GatewayBridge, type GatewayMessage } from "./controller"
import { memorySessionStore, sessionKey } from "./session"

/*
 * G4: a message from a chat becomes a turn of its bot, with a fake Rust side
 * and fake turns (or the real `runTurn` on a fake machine, where the plan's
 * places matter).
 */

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

function bridge(project: string | null = PROJECT) {
  let handler: ((message: GatewayMessage) => void) | undefined
  const calls: string[] = []
  const sent: { chat: string; text: string }[] = []
  const typing: string[] = []
  const fake: GatewayBridge = {
    listen: async (on) => {
      handler = on
      calls.push("listen")
      return () => {
        handler = undefined
        calls.push("unlisten")
      }
    },
    ready: async () => void calls.push("ready"),
    send: async (_bot, _platform, chat, text) => {
      sent.push({ chat, text })
      return String(sent.length)
    },
    typing: async (_bot, _platform, chat) => void typing.push(chat),
    project: async () => project ?? undefined,
  }
  const emit = (text: string, extra: Partial<GatewayMessage> = {}) =>
    handler?.({
      bot: BOT.path,
      platform: "telegram",
      chat: "c42",
      sender: { id: "42", name: "Ale" },
      text,
      id: String(Math.random()),
      redacted: false,
      button: false,
      ...extra,
    })
  return { fake, calls, sent, typing, emit }
}

/** Turns that end when the test says so. */
function fakeTurns() {
  const started: { request: TurnRequest; finish: (result: Partial<TurnResult>) => void; stopped: boolean }[] = []
  const runTurn = (request: TurnRequest): Turn => {
    let resolve!: (result: TurnResult) => void
    const result = new Promise<TurnResult>((done) => (resolve = done))
    const entry = {
      request,
      stopped: false,
      finish: (partial: Partial<TurnResult>) => resolve({ status: "done", text: "", tokens: 0, costUsd: 0, talk: emptyTalk(), ...partial }),
    }
    started.push(entry)
    return {
      result,
      stop: () => {
        entry.stopped = true
        entry.finish({ status: "stopped" })
      },
    }
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

describe("the gateways' controller", () => {
  test("it listens before Rust is told to read, and stops listening when stopped", async () => {
    const b = bridge()
    const controller = await startGatewayController({ bridge: b.fake, runTurn: fakeTurns().runTurn, loadBot: trusted, sessions: memorySessionStore() })
    expect(b.calls).toEqual(["listen", "ready"])
    controller.stop()
    expect(b.calls).toEqual(["listen", "ready", "unlisten"])
  })

  test("two messages in a row make one turn, then the other, in the same conversation", async () => {
    const b = bridge()
    const turns = fakeTurns()
    const sessions = memorySessionStore()
    await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot: trusted, sessions, typingEveryMs: 5 })
    b.emit("prima domanda")
    await until("il primo turno", () => turns.started.length === 1)
    b.emit("seconda domanda")
    await until("la seconda è in coda", () => b.sent.length === 1)
    expect(b.sent[0]!.text).toBe(t("gateway.queued", 1))
    expect(turns.started).toHaveLength(1)
    const first = turns.started[0]!.request
    expect(first.runner).toBe("claude")
    expect(first.cwd).toBe(PROJECT)
    expect(first.bot).toBe(BOT)
    expect(first.sessionId).toBeUndefined()
    expect(first.message).toBe(`${t("gateway.header", "Telegram", "Ale")}\n\nprima domanda`)
    await until("«sta scrivendo» ripetuto", () => b.typing.length >= 2)
    turns.started[0]!.finish({ text: "Prima risposta.", sessionId: "s-1" })
    await until("il secondo turno", () => turns.started.length === 2)
    expect(b.sent.map((sent) => sent.text)).toEqual([t("gateway.queued", 1), "Prima risposta."])
    expect(turns.started[1]!.request.sessionId).toBe("s-1")
    expect(turns.started[1]!.request.message.endsWith("seconda domanda")).toBe(true)
    turns.started[1]!.finish({ status: "error", problem: "rete giù" })
    await until("il motivo", () => b.sent.length === 3)
    expect(b.sent[2]!.text).toBe(t("gateway.failed", "rete giù"))
    expect(sessions.get(sessionKey(BOT.path, "telegram", "c42"))).toBe("s-1")
  })

  test("/ferma ends the turn with the CLI and gives the plan's place back, and empties the queue", async () => {
    const kills: unknown[] = []
    const machine: TurnDeps = {
      host: async () =>
        ({
          spawn: async () => ({ kill: (options: unknown) => void kills.push(options), write: () => {}, resize: () => {} }),
        }) as unknown as Awaited<ReturnType<NonNullable<TurnDeps["host"]>>>,
    }
    const b = bridge()
    await startGatewayController({ bridge: b.fake, runTurn: (request) => runTurn(request, machine), loadBot: trusted, sessions: memorySessionStore() })
    const before = turnsRunning("claude")
    b.emit("un lavoro lungo")
    await until("il turno occupa un posto", () => turnsRunning("claude") === before + 1)
    b.emit("e poi questo")
    await until("in coda", () => b.sent.length === 1)
    b.emit("/ferma")
    await until("fermato", () => b.sent.some((sent) => sent.text === t("gateway.stopped")))
    await until("il posto torna libero", () => turnsRunning("claude") === before)
    expect(kills).toEqual([{ tree: true }])
    // The queued message was dropped: no second turn, and the chat is free.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(turnsRunning("claude")).toBe(before)
    b.emit("/stato")
    await until("lo stato", () => b.sent.at(-1)!.text === t("gateway.status.idle"))
    b.emit("/ferma")
    await until("niente da fermare", () => b.sent.at(-1)!.text === t("gateway.nothingToStop"))
  })

  test("a bot whose file changed since the user's yes is refused in the chat, and no turn starts", async () => {
    const b = bridge()
    const turns = fakeTurns()
    const loadBot = async () => ({ ok: false as const, problem: t("gateway.retrust", "aiuto") })
    await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot, sessions: memorySessionStore() })
    b.emit("fai qualcosa")
    await until("il rifiuto", () => b.sent.length === 1)
    expect(b.sent[0]!.text).toBe(t("gateway.retrust", "aiuto"))
    expect(turns.started).toHaveLength(0)
  })

  test("a hidden key is said first; /nuova forgets the conversation; a gateway with no project says so", async () => {
    const b = bridge()
    const turns = fakeTurns()
    const sessions = memorySessionStore()
    const key = sessionKey(BOT.path, "telegram", "c42")
    sessions.set(key, "s-vecchia")
    await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot: trusted, sessions })
    b.emit("/nuova")
    await until("nuova conversazione", () => b.sent.length === 1)
    expect(b.sent[0]!.text).toBe(t("gateway.fresh"))
    expect(sessions.get(key)).toBeUndefined()
    b.emit("la chiave è [nascosto]", { redacted: true })
    await until("il turno", () => turns.started.length === 1)
    expect(b.sent[1]!.text).toBe(t("gateway.redacted"))
    expect(turns.started[0]!.request.sessionId).toBeUndefined()
    turns.started[0]!.finish({ text: "" })
    await until("la risposta vuota", () => b.sent.length === 3)
    expect(b.sent[2]!.text).toBe(t("gateway.empty"))

    const none = bridge(null)
    await startGatewayController({ bridge: none.fake, runTurn: turns.runTurn, loadBot: trusted, sessions })
    none.emit("ci sei?")
    await until("nessun progetto", () => none.sent.length === 1)
    expect(none.sent[0]!.text).toBe(t("gateway.noProject"))
  })

  test("past the hourly ceiling the chat is told once, then silence; a button press starts nothing yet", async () => {
    const b = bridge()
    const turns = fakeTurns()
    let now = 1_000
    await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot: trusted, sessions: memorySessionStore(), now: () => now })
    b.emit("ok:1", { button: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turns.started).toHaveLength(0)
    expect(b.sent).toHaveLength(0)
    for (let i = 0; i < 32; i++) b.emit(`messaggio ${i}`)
    await until("il limite", () => b.sent.some((sent) => sent.text === t("gateway.limit", 30)))
    const said = b.sent.filter((sent) => sent.text === t("gateway.limit", 30)).length
    expect(said).toBe(1)
    // An hour later the chat is heard again: the message is queued, not refused.
    now += 60 * 60_000
    const before = b.sent.length
    b.emit("di nuovo")
    await until("di nuovo accettato", () => b.sent.length === before + 1)
    expect(b.sent.at(-1)!.text).toBe(t("gateway.queued", 30))
  })
})
