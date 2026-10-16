import { describe, expect, test } from "bun:test"
import { t, setLocalePreference } from "../../i18n"
import type { AgentFile } from "../ragu"
import { emptyTalk, type PendingPermission } from "../talk"
import { turnsRunning } from "../terms"
import { runTurn, type Turn, type TurnDeps, type TurnRequest, type TurnResult } from "../turn"
import { createApprovalRegistry, decideApproval, mergeApprovals } from "../approvals"
import { ASK_TIMEOUT_MS, startGatewayController, safePreviewText, RECOVERED_NOTICE, recoveredNotice, type GatewayBridge, type GatewayMessage } from "./controller"
import { forgetTurnFailures, noteTurnFailure, turnFailureOf } from "./failures"
import { chatCommand, chatHeader } from "./policy"
import { localRemoteStore, memoryRemoteStore, offersRemoteCommands, REMOTE_OFF, remoteKey, remoteTools } from "./remote"
import { localSessionStore, memorySessionStore, sessionKey } from "./session"
import { createGatewayThreads, gatewayThreadKey, type ThreadDisk } from "./threads"
import { volatileMemoryStore } from "../memory"
import { appendMessage, sendMessage } from "../talk"

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

function bridge(
  project: string | null = PROJECT,
  linkStatus?: (bot: string, platform: string) => Promise<{ connected: boolean; connectedAtMs?: number | null } | undefined>,
) {
  let handler: ((message: GatewayMessage) => void) | undefined
  const calls: string[] = []
  const sent: { chat: string; text: string; final?: boolean; previewFallback?: string }[] = []
  const questions: { chat: string; text: string; buttons: readonly { label: string; data: string }[] }[] = []
  const typing: string[] = []
  const acks: { bot: string; platform: string; chat: string; id: string }[] = []
  const previews: { bot: string; platform: string; chat: string; text: string }[] = []
  const previewEnds: { bot: string; platform: string; chat: string; fallback?: string }[] = []
  const fake: GatewayBridge = {
    linkStatus: linkStatus ?? (async () => undefined),
    listen: async (on) => {
      handler = on
      calls.push("listen")
      return () => {
        handler = undefined
        calls.push("unlisten")
      }
    },
    ready: async () => void calls.push("ready"),
    ack: async (bot, platform, chat, id) => void acks.push({ bot, platform, chat, id }),
    send: async (_bot, _platform, chat, text, options) => {
      sent.push({ chat, text, final: options?.final, previewFallback: options?.previewFallback })
      return String(sent.length)
    },
    sendButtons: async (_bot, _platform, chat, text, buttons) => {
      questions.push({ chat, text, buttons })
      return "q"
    },
    typing: async (_bot, _platform, chat) => void typing.push(chat),
    preview: async (bot, platform, chat, text) => void previews.push({ bot, platform, chat, text }),
    previewEnd: async (bot, platform, chat, fallback) => void previewEnds.push({ bot, platform, chat, fallback }),
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
      private: true,
      ...extra,
    })
  return { fake, calls, sent, typing, questions, acks, previews, previewEnds, emit }
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
      finish: (partial: Partial<TurnResult>) =>
        resolve({ status: "done", text: "", tokens: 0, costUsd: 0, talk: emptyTalk(), ...partial }),
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

describe("a bot's memory from a chat (B8a review)", () => {
  test("read at the start of a conversation; what the bot writes is only proposed, and leaves its reply", async () => {
    const b = bridge()
    const turns = fakeTurns()
    const memory = volatileMemoryStore()
    memory.set(BOT.path, { notes: ["Il progetto usa bun."], user: [] })
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
      memory,
    })
    b.emit("ciao")
    await until("il turno", () => turns.started.length === 1)
    const first = turns.started[0]!.request
    expect(first.message).toContain("Il progetto usa bun.")
    expect(first.message.endsWith(`${chatHeader("Telegram", "Ale")}\n\nciao`)).toBe(true)
    const answer = 'Ciao!\n<ade-memory op="add" block="notes">Scrive da Telegram.</ade-memory>'
    const talk = appendMessage(sendMessage(emptyTalk(), first.message, 1), { role: "bot", text: answer }, 2)
    turns.started[0]!.finish({ text: answer, sessionId: "s-1", talk })
    await until("la risposta", () => b.sent.length === 1)
    expect(b.sent[0]!.text).toBe("Ciao!")
    expect(memory.get(BOT.path).notes).toEqual(["Il progetto usa bun."])
    expect(memory.get(BOT.path).proposals?.map((proposal) => [proposal.from, proposal.op])).toEqual([
      ["gateway", { op: "add", block: "notes", text: "Scrive da Telegram." }],
    ])
    // The same conversation goes on without the snapshot.
    b.emit("e poi?")
    await until("il secondo turno", () => turns.started.length === 2)
    expect(turns.started[1]!.request.message).toBe(`${chatHeader("Telegram", "Ale")}\n\ne poi?`)
    turns.started[1]!.finish({ text: "ok" })
  })
})

describe("the gateways' controller", () => {
  test("it listens before Rust is told to read, and stops listening when stopped", async () => {
    const b = bridge()
    const controller = await startGatewayController({
      bridge: b.fake,
      runTurn: fakeTurns().runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    expect(b.calls).toEqual(["listen", "ready"])
    controller.stop()
    expect(b.calls).toEqual(["listen", "ready", "unlisten"])
  })

  test("a message is explicitly acknowledged to the bridge (A3)", async () => {
    const b = bridge()
    await startGatewayController({
      bridge: b.fake,
      runTurn: fakeTurns().runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    b.emit("ciao", { id: "m42", bot: BOT.path, platform: "telegram" })
    expect(b.acks).toEqual([{ bot: BOT.path, platform: "telegram", chat: "c42", id: "m42" }])
  })

  test("a message waiting in queue behind a running turn is only acknowledged when its turn starts (A3)", async () => {
    const b = bridge()
    const turns = fakeTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    b.emit("primo", { id: "m1", bot: BOT.path, platform: "telegram", chat: "c42" })
    await until("il primo turno", () => turns.started.length === 1)
    b.emit("secondo", { id: "m2", bot: BOT.path, platform: "telegram", chat: "c42" })
    await until("la seconda è in coda", () => b.sent.length === 1)

    // Turn 1 started -> m1 is acked, but m2 is queued and NOT yet acked:
    expect(b.acks).toEqual([{ bot: BOT.path, platform: "telegram", chat: "c42", id: "m1" }])

    // Discarded command is acknowledged immediately even mid-turn:
    b.emit("/stato", { id: "m3", bot: BOT.path, platform: "telegram", chat: "c42" })
    expect(b.acks.some((a) => a.id === "m3")).toBe(true)

    // Finish turn 1:
    turns.started[0]!.finish({ text: "ok", sessionId: "s1" })
    await until("il secondo turno", () => turns.started.length === 2)
    // Now turn 2 starts -> m2 is acked:
    expect(b.acks.some((a) => a.id === "m2")).toBe(true)
  })

  test("a recovered message carries a recovered warning line for the model (A3.8)", async () => {
    setLocalePreference("it")
    const b = bridge()
    const turns = fakeTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    b.emit("domanda salvata", { id: "m42", bot: BOT.path, platform: "telegram", chat: "c42", recovered: true })
    await until("il turno è partito", () => turns.started.length === 1)
    const request = turns.started[0]!.request
    expect(request.message).toContain(recoveredNotice())
    expect(request.message).toContain("domanda salvata")
    expect(request.message.startsWith(recoveredNotice())).toBe(true)
    expect(recoveredNotice()).toBe(
      "[Messaggio recuperato: ricevuto mentre ADE era chiusa o in riavvio (può essere un duplicato).]",
    )

    setLocalePreference("en")
    expect(recoveredNotice()).toBe(
      "[Recovered message: received while ADE was closed or restarting (may be a duplicate).]",
    )
    setLocalePreference("system")
  })

  test("a message with the same (bot, platform, chat, id) is ignored and does not start a second turn (N-A3a)", async () => {
    const b = bridge()
    const turns = fakeTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    b.emit("prima domanda", { id: "m42", bot: BOT.path, platform: "telegram", chat: "c42" })
    await until("il primo turno", () => turns.started.length === 1)
    b.emit("prima domanda", { id: "m42", bot: BOT.path, platform: "telegram", chat: "c42" })
    expect(turns.started).toHaveLength(1)
    expect(b.sent).toHaveLength(0)
  })

  test("two messages in a row make one turn, then the other, in the same conversation", async () => {
    const b = bridge()
    const turns = fakeTurns()
    const sessions = memorySessionStore()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions,
      typingEveryMs: 5,
    })
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
    expect(first.message).toBe(`${chatHeader("Telegram", "Ale")}\n\nprima domanda`)
    await until("«sta scrivendo» ripetuto", () => b.typing.length >= 2)
    turns.started[0]!.finish({ text: "Prima risposta.", sessionId: "s-1" })
    await until("il secondo turno", () => turns.started.length === 2)
    expect(b.sent.map((sent) => sent.text)).toEqual([t("gateway.queued", 1), "Prima risposta."])
    expect(turns.started[1]!.request.sessionId).toBe("s-1")
    expect(turns.started[1]!.request.message.endsWith("seconda domanda")).toBe(true)
    turns.started[1]!.finish({ status: "error", problem: "rete giù" })
    await until("il motivo", () => b.sent.length === 3)
    expect(b.sent[2]!.text).toBe(t("gateway.failed"))
    expect(b.sent[2]!.text).not.toContain("rete giù")
    expect(sessions.get(sessionKey(BOT.path, "telegram", "c42"))).toEqual({
      project: PROJECT,
      runner: "claude",
      sessionId: "s-1",
    })
  })

  test("the chat's thread is kept without a secret, and /nuova drops it", async () => {
    const b = bridge()
    const turns = fakeTurns()
    const data = new Map<string, string>()
    const disk: ThreadDisk = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
    }
    const threads = createGatewayThreads(disk)
    const secret = "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789"
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
      threads,
    })
    b.emit("ciao")
    await until("il turno", () => turns.started.length === 1)
    turns.started[0]!.finish({
      text: "ecco",
      sessionId: "s-1",
      talk: {
        ...emptyTalk(),
        messages: [{ id: "t1", role: "tool", tool: "bash", text: "env", output: secret, at: 1 }],
        sessionId: "s-1",
      },
    })
    const key = gatewayThreadKey(BOT.path, "telegram", "c42")
    await until("il filo", () => data.has(key))
    expect(data.get(key)).not.toContain(secret)
    expect(createGatewayThreads(disk).read(key).messages).toHaveLength(1)
    b.emit("/nuova")
    await until("dimenticato", () => !data.has(key))
  })

  test("/ferma ends the turn with the CLI and gives the plan's place back, and empties the queue", async () => {
    const kills: unknown[] = []
    const machine: TurnDeps = {
      host: async () =>
        ({
          spawn: async () => ({
            kill: (options: unknown) => void kills.push(options),
            write: () => {},
            resize: () => {},
          }),
        }) as unknown as Awaited<ReturnType<NonNullable<TurnDeps["host"]>>>,
    }
    const b = bridge()
    await startGatewayController({
      bridge: b.fake,
      runTurn: (request) => runTurn(request, machine),
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
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

  test("un turno dal gateway porta il flag dell'account", async () => {
    const seen: { flags?: readonly string[]; secrets?: readonly string[] }[] = []
    const machine: TurnDeps = {
      host: async () =>
        ({
          spawn: async (options: {
            flags?: readonly string[]
            secrets?: readonly string[]
            onExit: (code: number | null) => void
          }) => {
            seen.push({
              ...(options.flags ? { flags: options.flags } : {}),
              ...(options.secrets ? { secrets: options.secrets } : {}),
            })
            options.onExit(0)
            return { kill: () => {}, write: () => {}, resize: () => {} }
          },
        }) as unknown as Awaited<ReturnType<NonNullable<TurnDeps["host"]>>>,
    }
    const b = bridge()
    await startGatewayController({
      bridge: b.fake,
      runTurn: (request) => runTurn(request, machine),
      loadBot: trusted,
      sessions: memorySessionStore(),
      account: () => ({ mode: "key", key: "lavoro" }),
    })
    b.emit("ciao")
    await until("avviato", () => seen.length === 1)
    expect(seen[0]!.flags).toEqual(["account-key"])
    expect(seen[0]!.secrets).toEqual(["lavoro"])
    await until("risposto", () => b.sent.length >= 1)
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
    sessions.set(key, { project: PROJECT, runner: "claude", sessionId: "s-vecchia" })
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

  test("/nuova during a turn is not undone when the turn ends (review area 2)", async () => {
    const b = bridge()
    const turns = fakeTurns()
    const sessions = memorySessionStore()
    const data = new Map<string, string>()
    const threads = createGatewayThreads({
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
    })
    const key = sessionKey(BOT.path, "telegram", "c42")
    await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot: trusted, sessions, threads })
    b.emit("ciao")
    await until("il turno", () => turns.started.length === 1)
    b.emit("/nuova")
    await until("nuova conversazione", () => b.sent.some((sent) => sent.text === t("gateway.fresh")))
    turns.started[0]!.finish({
      text: "ecco",
      sessionId: "s-vecchia",
      talk: { ...emptyTalk(), messages: [{ id: "m1", role: "bot", text: "ecco", at: 1 }], sessionId: "s-vecchia" },
    })
    await until("la risposta", () => b.sent.some((sent) => sent.text === "ecco"))
    expect(sessions.get(key)).toBeUndefined()
    expect(data.has(gatewayThreadKey(BOT.path, "telegram", "c42"))).toBe(false)
  })

  test("a conversation saved in another project, or on another CLI, is not continued", async () => {
    const key = sessionKey(BOT.path, "telegram", "c42")
    for (const saved of [
      { project: "C:/altro-progetto", runner: "claude", sessionId: "s-altrove" },
      { project: PROJECT, runner: "codex", sessionId: "s-codex" },
    ]) {
      const b = bridge()
      const turns = fakeTurns()
      const sessions = memorySessionStore()
      sessions.set(key, saved)
      await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot: trusted, sessions })
      b.emit("ciao")
      await until("il turno", () => turns.started.length === 1)
      expect(turns.started[0]!.request.sessionId).toBeUndefined()
      turns.started[0]!.finish({ text: "ok", sessionId: "s-nuova" })
      await until("la sessione nuova", () => sessions.get(key)?.sessionId === "s-nuova")
      expect(sessions.get(key)).toEqual({ project: PROJECT, runner: "claude", sessionId: "s-nuova" })
    }
  })

  test("a conversation saved before it said where it ran, or anything else found saved, is none", () => {
    const storage = `ade.gateway.sessions.test.${Math.random()}`
    localStorage.setItem(storage, JSON.stringify({ a: "s-vecchia", b: { project: "C:/p", runner: "claude" }, c: 7 }))
    const sessions = localSessionStore(storage)
    for (const key of ["a", "b", "c", "d"]) expect(sessions.get(key)).toBeUndefined()
    sessions.set("a", { project: "C:/p", runner: "ragu", sessionId: "s-1" })
    expect(localSessionStore(storage).get("a")).toEqual({ project: "C:/p", runner: "ragu", sessionId: "s-1" })
    localStorage.removeItem(storage)
  })

  test("a message a key was taken out of keeps its place: the one after it does not go first", async () => {
    const b = bridge()
    const turns = fakeTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    b.emit("la prima, con una chiave", { redacted: true })
    b.emit("la seconda")
    await until("il primo turno", () => turns.started.length === 1)
    await until("la seconda in coda", () => b.sent.length === 2)
    expect(turns.started[0]!.request.message.endsWith("la prima, con una chiave")).toBe(true)
    expect(b.sent.map((sent) => sent.text)).toEqual([t("gateway.redacted"), t("gateway.queued", 1)])
  })

  test("a press counts only for a button ADE sent, in that chat, while its question waits, and once", async () => {
    const b = bridge()
    const turns = fakeTurns()
    const controller = await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    const target = { bot: BOT.path, platform: "telegram", chat: "c42" }
    const answer = controller.ask(target, "Eseguo `ls`?", [
      { label: "Sì", value: "yes" },
      { label: "No", value: "no" },
    ])
    await until("la domanda", () => b.questions.length === 1)
    const [yes, no] = b.questions[0]!.buttons
    expect(yes!.label).toBe("Sì")
    expect(yes!.data).toMatch(/^[0-9a-f]{16}:0$/)
    const id = yes!.data.split(":")[0]!
    // Made up by the client, from another chat, an index that is not there: ignored.
    b.emit("0123456789abcdef:0", { button: true })
    b.emit(yes!.data, { button: true, chat: "c7" })
    b.emit(`${id}:9`, { button: true })
    b.emit(`${id}:01`, { button: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    let settled = false
    void answer.then(() => (settled = true))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(settled).toBe(false)
    b.emit(no!.data, { button: true })
    expect(await answer).toBe("no")
    // Once: a second press of the same question does nothing, and no press starts a turn.
    b.emit(yes!.data, { button: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turns.started).toHaveLength(0)
    expect(b.sent).toHaveLength(0)
  })

  test("a question nobody answers in time, or still waiting when the controller stops, has no answer", async () => {
    const b = bridge()
    const controller = await startGatewayController({
      bridge: b.fake,
      runTurn: fakeTurns().runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    const target = { bot: BOT.path, platform: "telegram", chat: "c42" }
    expect(await controller.ask(target, "Procedo?", [{ label: "Sì", value: "yes" }], 20)).toBeUndefined()
    const late = b.questions[0]!.buttons[0]!.data
    b.emit(late, { button: true })
    const waiting = controller.ask(target, "E ora?", [{ label: "Sì", value: "yes" }])
    await until("la seconda domanda", () => b.questions.length === 2)
    controller.stop()
    expect(await waiting).toBeUndefined()
  })

  test("past the hourly ceiling the chat is told once, then silence; a button press starts nothing", async () => {
    const b = bridge()
    const turns = fakeTurns()
    let now = 1_000
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
      now: () => now,
    })
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

  test("a turn exposes partial text to the gateway controller during generation", async () => {
    const b = bridge()
    const turns = fakeTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    b.emit("ciao")
    await until("il turno è partito", () => turns.started.length === 1)
    const turn = turns.started[0]!
    expect(turn.request.partial).toBe(true)
    expect(typeof turn.request.onUpdate).toBe("function")

    const talk = { ...emptyTalk(), streaming: "Sto pensando alla risposta giusta... " }
    turn.request.onUpdate!(talk)
    await Promise.resolve()

    expect(b.previews).toEqual([
      { bot: BOT.path, platform: "telegram", chat: "c42", text: "Sto pensando alla risposta giusta... " },
    ])
    turn.finish({ text: "Risposta finale." })
    await until("la risposta finale", () => b.sent.length === 1)
    expect(b.sent).toEqual([
      { chat: "c42", text: "Risposta finale.", final: true, previewFallback: t("gateway.preview.sentBelow") },
    ])
  })

  test("preview updates are throttled to at most ~1/s and at least 24 new characters", async () => {
    const b = bridge()
    const turns = fakeTurns()
    let now = 10_000
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
      now: () => now,
    })
    b.emit("ciao")
    await until("il turno è partito", () => turns.started.length === 1)
    const turn = turns.started[0]!

    // Text < 24 chars -> no preview sent
    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Breve" })
    await Promise.resolve()
    expect(b.previews).toHaveLength(0)

    // Text >= 24 chars -> first preview sent
    const part1 = "Questo testo ha almeno 24 caratteri. "
    turn.request.onUpdate!({ ...emptyTalk(), streaming: part1 })
    await Promise.resolve()
    expect(b.previews).toHaveLength(1)
    expect(b.previews[0]!.text).toBe(part1)

    // Only 500ms later (less than 1s) with plenty of new characters -> throttled, not sent
    now += 500
    const part2 = part1 + "Altri caratteri aggiunti velocemente. "
    turn.request.onUpdate!({ ...emptyTalk(), streaming: part2 })
    await Promise.resolve()
    expect(b.previews).toHaveLength(1)

    // 1000ms later (now + 1000ms) but only 10 new chars (< 24 delta) -> not sent
    now += 1_000
    const part3 = part1 + " 123456789"
    turn.request.onUpdate!({ ...emptyTalk(), streaming: part3 })
    await Promise.resolve()
    expect(b.previews).toHaveLength(1)

    // 1000ms later with >= 24 new chars -> sent!
    const part4 = part1 + "E ora ci sono sicuramente più di ventiquattro caratteri in più. "
    turn.request.onUpdate!({ ...emptyTalk(), streaming: part4 })
    await Promise.resolve()
    expect(b.previews).toHaveLength(2)
    expect(b.previews[1]!.text).toBe(part4)
  })

  test("preview cadence defaults to 2s on Discord and 1s on Telegram", async () => {
    let now = 10_000
    const b = bridge()
    const turns = fakeTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
      now: () => now,
    })

    // Discord message
    b.emit("ciao discord", { platform: "discord", chat: "d1" })
    await until("turno discord partito", () => turns.started.length === 1)
    const turnDiscord = turns.started[0]!

    // First update sent immediately
    const dPart1 = "Testo di anteprima discord con più di ventiquattro caratteri."
    turnDiscord.request.onUpdate!({ ...emptyTalk(), streaming: dPart1 })
    await Promise.resolve()
    expect(b.previews).toHaveLength(1)

    // After 1.1s: on Discord (2s cadence) this update is throttled and NOT sent
    now += 1_100
    const dPart2 = dPart1 + " Altro testo discord sufficientemente lungo da superare la soglia."
    turnDiscord.request.onUpdate!({ ...emptyTalk(), streaming: dPart2 })
    await Promise.resolve()
    expect(b.previews).toHaveLength(1)

    // After total 2.1s: on Discord update is sent
    now += 1_000
    const dPart3 = dPart2 + " Ancora altro testo discord lungo abbastanza."
    turnDiscord.request.onUpdate!({ ...emptyTalk(), streaming: dPart3 })
    await Promise.resolve()
    expect(b.previews).toHaveLength(2)

    turnDiscord.finish({ text: "Fine discord." })
    await until("discord finito", () => b.sent.length === 1)

    // Telegram message
    now += 5_000
    b.emit("ciao telegram", { platform: "telegram", chat: "t1" })
    await until("turno telegram partito", () => turns.started.length === 2)
    const turnTelegram = turns.started[1]!

    // First update sent immediately
    const tPart1 = "Testo di anteprima telegram con più di ventiquattro caratteri."
    turnTelegram.request.onUpdate!({ ...emptyTalk(), streaming: tPart1 })
    await Promise.resolve()
    expect(b.previews).toHaveLength(3)

    // After 1.1s: on Telegram (1s cadence) update IS sent
    now += 1_100
    const tPart2 = tPart1 + " Altro testo telegram sufficientemente lungo da superare la soglia."
    turnTelegram.request.onUpdate!({ ...emptyTalk(), streaming: tPart2 })
    await Promise.resolve()
    expect(b.previews).toHaveLength(4)

    turnTelegram.finish({ text: "Fine telegram." })
    await until("telegram finito", () => b.sent.length === 2)
  })


  test("stops previewing after 3 consecutive 429 flood errors on that message", async () => {
    let attempts = 0
    let now = 10_000
    const b = bridge()
    b.fake.preview = async (_bot, _platform, _chat, _text) => {
      attempts++
      throw new Error("429 Too Many Requests (flood control)")
    }
    const turns = fakeTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
      now: () => now,
    })
    b.emit("ciao")
    await until("il turno è partito", () => turns.started.length === 1)
    const turn = turns.started[0]!

    // Attempt 1 (429)
    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Primo tentativo con più di ventiquattro caratteri." })
    await Promise.resolve()
    expect(attempts).toBe(1)

    // Attempt 2 (429)
    now += 1_100
    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Primo tentativo con più di ventiquattro caratteri. Secondo tentativo lungo abbastanza." })
    await Promise.resolve()
    expect(attempts).toBe(2)

    // Attempt 3 (429) -> flood limit reached
    now += 1_100
    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Primo tentativo con più di ventiquattro caratteri. Secondo tentativo lungo abbastanza. Terzo tentativo lungo abbastanza." })
    await Promise.resolve()
    expect(attempts).toBe(3)

    // Attempt 4 -> preview disabled, should not even call preview
    now += 1_100
    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Primo tentativo con più di ventiquattro caratteri. Secondo tentativo lungo abbastanza. Terzo tentativo lungo abbastanza. Quarto tentativo lungo." })
    await Promise.resolve()
    expect(attempts).toBe(3)

    // Turn finishes: final response is still delivered
    turn.finish({ text: "Risposta finale dopo i 429." })
    await until("risposta finale", () => b.sent.length === 1)
    expect(b.sent[0]!.text).toBe("Risposta finale dopo i 429.")
  })

  test("stops previewing after 3 consecutive structured Discord flood errors (Flood: prefix)", async () => {
    let attempts = 0
    let now = 10_000
    const b = bridge()
    b.fake.preview = async (_bot, _platform, _chat, _text) => {
      attempts++
      throw new Error("Flood: Discord: You are being rate limited.")
    }
    const turns = fakeTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
      now: () => now,
    })
    b.emit("ciao")
    await until("il turno è partito", () => turns.started.length === 1)
    const turn = turns.started[0]!

    // Attempt 1 (Flood)
    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Primo tentativo con più di ventiquattro caratteri. " })
    await Promise.resolve()
    expect(attempts).toBe(1)

    // Attempt 2 (Flood)
    now += 1_100
    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Primo tentativo con più di ventiquattro caratteri. Secondo tentativo lungo abbastanza. " })
    await Promise.resolve()
    expect(attempts).toBe(2)

    // Attempt 3 (Flood) -> limit reached
    now += 1_100
    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Primo tentativo con più di ventiquattro caratteri. Secondo tentativo lungo abbastanza. Terzo tentativo lungo abbastanza. " })
    await Promise.resolve()
    expect(attempts).toBe(3)

    // Attempt 4 -> preview disabled, should not even call preview
    now += 1_100
    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Primo tentativo con più di ventiquattro caratteri. Secondo tentativo lungo abbastanza. Terzo tentativo lungo abbastanza. Quarto tentativo lungo. " })
    await Promise.resolve()
    expect(attempts).toBe(3)
  })

  test("holds back trailing incomplete token/secret until terminated by delimiter", async () => {
    expect(safePreviewText("Ecco la chiave: sk-proj")).toBe("Ecco la chiave: ")
    expect(safePreviewText("Ecco la chiave: sk-proj-1234567890 ")).toBe("Ecco la chiave: sk-proj-1234567890 ")
    expect(safePreviewText("Prima riga.\nSeconda")).toBe("Prima riga.\n")
    expect(safePreviewText("Incompleto")).toBe("")

    // P2-1: safePreviewText holds back partial secrets (JWT, password with dot, password=ab.)
    // 1. JWT: delimiter is only whitespace, dot must not release partial header/payload
    const jwtPartial = "Il token è eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkw"
    expect(safePreviewText(jwtPartial)).toBe("Il token è ")

    // 2. Password containing a dot: must not be cut at the dot
    const passWithDot = "Ecco la password: pass.word123"
    expect(safePreviewText(passWithDot)).toBe("")

    // 3. password=ab.
    expect(safePreviewText("password=ab.")).toBe("")
    expect(safePreviewText("Configurazione:\npassword=ab.")).toBe("Configurazione:\n")
    expect(safePreviewText("Configurazione:\npassword=ab. ")).toBe("Configurazione:\n")

    const b = bridge()
    const turns = fakeTurns()
    let now = 10_000
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
      now: () => now,
    })
    b.emit("ciao")
    await until("il turno è partito", () => turns.started.length === 1)
    const turn = turns.started[0]!

    // Incomplete secret: trailing "sk-proj" has no delimiter, so only the prefix is sent
    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Questo è il prefisso prima del segreto: sk-proj" })
    await Promise.resolve()
    expect(b.previews).toHaveLength(1)
    expect(b.previews[0]!.text).toBe("Questo è il prefisso prima del segreto: ")

    // Once delimiter is present, the full token is included
    now += 1_100
    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Questo è il prefisso prima del segreto: sk-proj-1234567890abcdef " })
    await Promise.resolve()
    expect(b.previews).toHaveLength(2)
    expect(b.previews[1]!.text).toBe("Questo è il prefisso prima del segreto: sk-proj-1234567890abcdef ")
  })

  test("preview does not show memory operation tags (P2-N2)", async () => {
    const b = bridge()
    const turns = fakeTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    b.emit("ricordati di me")
    await until("il turno è partito", () => turns.started.length === 1)
    const turn = turns.started[0]!

    // Text with memory tags
    const rawWithMemory = 'Risposta normale.\n<ade-memory block="notes" op="add">\nNota da ricordare\n</ade-memory>\nAltra riga di risposta. Coda'
    turn.request.onUpdate!({ ...emptyTalk(), streaming: rawWithMemory })
    await Promise.resolve()
    expect(b.previews).toHaveLength(1)
    expect(b.previews[0]!.text).not.toContain("ade-memory")
    expect(b.previews[0]!.text).not.toContain("Nota da ricordare")
    expect(b.previews[0]!.text).toBe("Risposta normale.\n\nAltra riga di risposta. ")
  })

  test("/ferma closes the preview with the stopped message and stops further previewing", async () => {
    const b = bridge()
    const turns = fakeTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    b.emit("fai qualcosa")
    await until("il turno è partito", () => turns.started.length === 1)
    const turn = turns.started[0]!

    // Send a preview
    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Sto elaborando la tua richiesta... " })
    await Promise.resolve()
    expect(b.previews).toHaveLength(1)

    // Stop with /ferma
    b.emit("/ferma")
    await until("fermato", () => b.sent.some((s) => s.text === t("gateway.stopped")))

    // Subsequent updates do not send previews
    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Sto elaborando la tua richiesta... altro testo lungo aggiunto dopo lo stop." })
    await Promise.resolve()
    expect(b.previews).toHaveLength(1)
  })

  test("mid-turn approval pauses preview updates until user answers", async () => {
    const b = bridge()
    const started: { request: TurnRequest; finish: () => void }[] = []
    const keys: string[] = []
    const runTurn = (request: TurnRequest): Turn => {
      let resolve!: (result: TurnResult) => void
      const result = new Promise<TurnResult>((done) => (resolve = done))
      const entry = {
        request,
        finish: () => resolve({ status: "done", text: "Fatto.", tokens: 0, costUsd: 0, talk: emptyTalk() }),
      }
      started.push(entry)
      return {
        result,
        stop: () => entry.finish(),
        answer: (_req, reply) => void keys.push(reply),
      }
    }
    const RAGU: AgentFile = { ...BOT, runner: "ragu" }
    const raguBot = async () => ({ ok: true as const, bot: RAGU, fingerprint: "f-1" })
    let now = 10_000
    await startGatewayController({
      bridge: b.fake,
      runTurn,
      loadBot: raguBot,
      sessions: memorySessionStore(),
      remote: () => ({ commands: true, fingerprint: "f-1" }),
      now: () => now,
    })
    b.emit("esegui comando", { private: true })
    await until("il turno è partito", () => started.length === 1)
    const turn = started[0]!

    // Send preview before approval
    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Inizio esecuzione del comando... " })
    await Promise.resolve()
    expect(b.previews).toHaveLength(1)

    // Mid-turn permission question is asked
    turn.request.onPermission?.({
      requestID: "per_1",
      permission: "bash",
      patterns: "rm -rf build",
      askedAt: 0,
    })
    await until("domanda arrivata", () => b.questions.length === 1)

    // During pending approval, updates do NOT send previews even after cadence
    now += 1_100
    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Inizio esecuzione del comando... ancora testo generato durante l'attesa dell'approvazione." })
    await Promise.resolve()
    expect(b.previews).toHaveLength(1)

    // User answers the question
    b.emit(b.questions[0]!.buttons[0]!.data, { button: true })
    await until("risposta registrata", () => keys.length === 1)

    // After approval answered, preview updates resume
    now += 1_100
    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Inizio esecuzione del comando... ripresa dopo approvazione con testo sufficientemente lungo." })
    await Promise.resolve()
    expect(b.previews).toHaveLength(2)
  })

  test("mid-turn approval question and queued notice do not consume preview; only final turn message has final: true", async () => {
    const b = bridge()
    const started: { request: TurnRequest; finish: (result: Partial<TurnResult>) => void }[] = []
    const keys: string[] = []
    const runTurn = (request: TurnRequest): Turn => {
      let resolve!: (result: TurnResult) => void
      const result = new Promise<TurnResult>((done) => (resolve = done))
      const entry = {
        request,
        finish: (partial: Partial<TurnResult>) =>
          resolve({ status: "done", text: "Fatto.", tokens: 0, costUsd: 0, talk: emptyTalk(), ...partial }),
      }
      started.push(entry)
      return {
        result,
        stop: () => entry.finish({ status: "stopped" }),
        answer: (_req, reply) => void keys.push(reply),
      }
    }
    const RAGU: AgentFile = { ...BOT, runner: "ragu" }
    const raguBot = async () => ({ ok: true as const, bot: RAGU, fingerprint: "f-1" })
    let now = 10_000
    await startGatewayController({
      bridge: b.fake,
      runTurn,
      loadBot: raguBot,
      sessions: memorySessionStore(),
      remote: () => ({ commands: true, fingerprint: "f-1" }),
      now: () => now,
    })
    b.emit("comando primo", { private: true })
    await until("il turno è partito", () => started.length === 1)
    const turn = started[0]!

    // 1. First preview
    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Inizio esecuzione del comando prima della domanda..." })
    await Promise.resolve()
    expect(b.previews).toHaveLength(1)

    // 2. Mid-turn permission question is asked
    turn.request.onPermission?.({
      requestID: "per_p1",
      permission: "bash",
      patterns: "cargo check",
      askedAt: 0,
    })
    await until("domanda arrivata", () => b.questions.length === 1)
    expect(b.questions[0]!.buttons.length).toBeGreaterThan(0)

    // 3. Mid-turn message in queue while turn is live
    b.emit("secondo messaggio in coda", { private: true })
    await until("avviso in coda", () => b.sent.some((s) => s.text === t("gateway.queued", 1)))
    const queuedNotice = b.sent.find((s) => s.text === t("gateway.queued", 1))
    expect(queuedNotice?.final).toBeFalsy()

    // 4. User answers the permission question
    b.emit(b.questions[0]!.buttons[0]!.data, { button: true })
    await until("risposta registrata", () => keys.length === 1)

    // 5. Preview resumes
    now += 1_100
    turn.request.onUpdate!({
      ...emptyTalk(),
      streaming: "Inizio esecuzione del comando prima della domanda... e adesso continuiamo con moltissimi nuovi caratteri generati dopo l'approvazione.",
    })
    await Promise.resolve()
    expect(b.previews).toHaveLength(2)

    // 6. Final turn result
    turn.finish({ text: "Risposta finale completa." })
    await until("risposta finale arrivata", () => b.sent.some((s) => s.text === "Risposta finale completa."))
    const finalMsg = b.sent.find((s) => s.text === "Risposta finale completa.")
    expect(finalMsg?.final).toBe(true)
  })

  test("Case A: fast turn awaits in-flight preview before sending final reply", async () => {
    const b = bridge()
    let previewRunning = false
    let previewFinished = false
    let finalSentWhilePreviewInFlight = false
    b.fake.preview = async (_bot, _platform, _chat, _text) => {
      previewRunning = true
      await new Promise((resolve) => setTimeout(resolve, 50))
      previewRunning = false
      previewFinished = true
    }
    const origSend = b.fake.send
    b.fake.send = async (bot, platform, chat, text, options) => {
      if (options?.final && previewRunning) {
        finalSentWhilePreviewInFlight = true
      }
      return origSend(bot, platform, chat, text, options)
    }

    const turns = fakeTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    b.emit("turno rapido")
    await until("il turno è partito", () => turns.started.length === 1)
    const turn = turns.started[0]!

    // Start in-flight preview
    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Sto generando testo parziale sufficientemente lungo..." })
    // Turn finishes immediately while preview is still in flight!
    turn.finish({ text: "Risposta finale immediata." })

    await until("risposta finale arrivata", () => b.sent.some((s) => s.text === "Risposta finale immediata."))
    expect(previewFinished).toBe(true)
    expect(finalSentWhilePreviewInFlight).toBe(false)
  })

  test("Case C: turn closed without reply (revoke / /ferma) cleans up preview in finally", async () => {
    const b = bridge()
    const turns = fakeTurns()
    const controller = await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    b.emit("messaggio da revocare", { sender: { id: "rev_user", name: "Rev" } })
    await until("il turno è partito", () => turns.started.length === 1)
    const turn = turns.started[0]!

    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Generazione parziale prima della revoca..." })
    await Promise.resolve()
    expect(b.previews).toHaveLength(1)

    // User is revoked mid-turn
    controller.revoke(BOT.path, "telegram", "rev_user")
    await until("previewEnd chiamato in finally", () => b.previewEnds.length === 1)
    expect(b.previewEnds).toEqual([{ bot: BOT.path, platform: "telegram", chat: "c42", fallback: t("gateway.preview.interrupted") }])
  })

  test("fallback preview notice texts follow ADE language (P2-N4)", async () => {
    // 1. Italian
    setLocalePreference("it")
    const bIt = bridge()
    const turnsIt = fakeTurns()
    await startGatewayController({
      bridge: bIt.fake,
      runTurn: turnsIt.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    bIt.emit("ciao")
    await until("il turno è partito", () => turnsIt.started.length === 1)
    turnsIt.started[0]!.finish({ text: "Risposta completata" })
    await until("risposta inviata", () => bIt.sent.length === 1)
    expect(bIt.sent[0]!.previewFallback).toBe("(risposta inviata sotto)")
    await until("previewEnd chiamato in finally", () => bIt.previewEnds.length === 1)
    expect(bIt.previewEnds[0]!.fallback).toBe("(interrotto)")

    // 2. English
    setLocalePreference("en")
    try {
      const bEn = bridge()
      const turnsEn = fakeTurns()
      await startGatewayController({
        bridge: bEn.fake,
        runTurn: turnsEn.runTurn,
        loadBot: trusted,
        sessions: memorySessionStore(),
      })
      bEn.emit("hello")
      await until("il turno è partito", () => turnsEn.started.length === 1)
      turnsEn.started[0]!.finish({ text: "Completed reply" })
      await until("risposta inviata", () => bEn.sent.length === 1)
      expect(bEn.sent[0]!.previewFallback).toBe("(reply sent below)")
      await until("previewEnd chiamato in finally", () => bEn.previewEnds.length === 1)
      expect(bEn.previewEnds[0]!.fallback).toBe("(interrupted)")
    } finally {
      setLocalePreference("it")
    }
  })

  test("failed turn cleans up and sends failure message without hanging preview", async () => {
    const b = bridge()
    const turns = fakeTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    b.emit("fai crashare")
    await until("il turno è partito", () => turns.started.length === 1)
    const turn = turns.started[0]!

    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Sto per fallire male in questo turno lungo..." })
    await Promise.resolve()
    expect(b.previews).toHaveLength(1)

    turn.finish({ status: "error", problem: "crash fatale" })
    await until("messaggio di errore", () => b.sent.length === 1)
    expect(b.sent[0]!.text).toBe(t("gateway.failed"))
  })

  test("recovered message and preview do not touch ack twice", async () => {
    const b = bridge()
    const turns = fakeTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    b.emit("messaggio recuperato", { recovered: true, id: "msg-rec-1" })
    await until("il turno è partito", () => turns.started.length === 1)
    const turn = turns.started[0]!

    // Ack called on turn start
    expect(b.acks).toEqual([{ bot: BOT.path, platform: "telegram", chat: "c42", id: "msg-rec-1" }])

    // Preview does not call ack
    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Anteprima di un messaggio recuperato..." })
    await Promise.resolve()
    expect(b.previews).toHaveLength(1)
    expect(b.acks).toHaveLength(1)

    turn.finish({ text: "Completato." })
    await until("finito", () => b.sent.length === 1)
    expect(b.acks).toHaveLength(1)
  })
})

/*
 * G5, D93: a turn from a chat has no shell unless the owner turned on the
 * bot's remote commands; then every command ragu asks about is asked on the
 * phone, and no answer in time is a no.
 */
describe("the tools of a turn from a chat", () => {
  const RAGU: AgentFile = { ...BOT, runner: "ragu" }
  const ragu = async () => ({ ok: true as const, bot: RAGU, fingerprint: "f-1" })
  const on = { commands: true, fingerprint: "f-1" }

  /** A question as ragu's server event gives it (B8d). */
  const asking = (permission: string, patterns: string): PendingPermission => ({
    requestID: `per_${patterns}`,
    permission,
    patterns,
    askedAt: 0,
  })

  /** Turns that record the answers given to them. */
  function typedTurns() {
    const started: { request: TurnRequest; keys: string[]; ids: string[]; finish: () => void }[] = []
    const runTurn = (request: TurnRequest): Turn => {
      let resolve!: (result: TurnResult) => void
      const result = new Promise<TurnResult>((done) => (resolve = done))
      const entry = {
        request,
        keys: [] as string[],
        ids: [] as string[],
        finish: () => resolve({ status: "done", text: "Fatto.", tokens: 0, costUsd: 0, talk: emptyTalk() }),
      }
      started.push(entry)
      return {
        result,
        stop: () => entry.finish(),
        answer: (requestID, reply) => void (entry.keys.push(reply), entry.ids.push(requestID)),
      }
    }
    return { started, runTurn }
  }

  test("with nothing turned on the turn gets no shell", async () => {
    for (const loadBot of [trusted, ragu]) {
      const b = bridge()
      const turns = typedTurns()
      await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot, sessions: memorySessionStore() })
      b.emit("pulisci la build")
      await until("il turno", () => turns.started.length === 1)
      expect(turns.started[0]!.request.remote).toEqual({ commands: false })
    }
  })

  /*
   * G5 review, M2: with the commands off nobody was watching ragu's menu, so
   * any question (outside the project, a `.env`, a loop) left the turn waiting
   * until it timed out, «sta scrivendo» on the phone the whole time.
   */
  test("with the commands off ragu's every question is answered no at once, and the chat is told once", async () => {
    const b = bridge()
    const turns = typedTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: ragu,
      sessions: memorySessionStore(),
    })
    b.emit("leggi i file fuori")
    await until("il turno", () => turns.started.length === 1)
    const turn = turns.started[0]!
    expect(turn.request.onPermission).toBeDefined()
    turn.request.onPermission!(asking("external_directory", "C:/Users/me/Documents/*"))
    await until("il no", () => turn.keys.length === 1)
    expect(turn.keys).toEqual(["reject"])
    await until("l'avviso", () => b.sent.length === 1)
    expect(b.sent[0]!.text).toBe(t("gateway.approve.refused", "external_directory", "C:/Users/me/Documents/*"))
    // The same permission again: refused again, said once.
    turn.request.onPermission!(asking("external_directory", "D:/altro/*"))
    await until("il secondo no", () => turn.keys.length === 2)
    turn.request.onPermission!(asking("read", "C:/progetto/.env"))
    await until("il terzo no", () => turn.keys.length === 3)
    expect(turn.keys).toEqual(["reject", "reject", "reject"])
    await until("il secondo avviso", () => b.sent.length === 2)
    expect(b.sent[1]!.text).toBe(t("gateway.approve.refused", "read", "C:/progetto/.env"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(b.questions).toHaveLength(0)
    expect(b.sent).toHaveLength(2)
  })

  /* B8c: the block list before the phone. */
  test("a blocked command is refused before any question, and the chat is told why", async () => {
    const b = bridge()
    const turns = typedTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: ragu,
      sessions: memorySessionStore(),
      remote: () => on,
    })
    b.emit("formatta il disco")
    await until("il turno", () => turns.started.length === 1)
    const turn = turns.started[0]!
    turn.request.onPermission!(asking("bash", "rm -rf /"))
    await until("il no", () => turn.keys.length === 1)
    expect(turn.keys).toEqual(["reject"])
    await until("l'avviso", () => b.sent.length === 1)
    expect(b.sent[0]!.text).toBe(t("gateway.approve.blocked", "rm -rf /", t("bots.approval.reason.deleteRoot")))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(b.questions).toHaveLength(0)
  })

  /* B8d: a question is ragu's event with its id; no output is read, so nothing the model writes can be one. */
  test("a ragu turn from a chat takes its questions as events", async () => {
    const b = bridge()
    const turns = typedTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: ragu,
      sessions: memorySessionStore(),
      remote: () => on,
    })
    b.emit("elenca i file")
    await until("il turno", () => turns.started.length === 1)
    const turn = turns.started[0]!
    expect(turn.request.onPermission).toBeDefined()
  })

  /* S17 (review of the bots): a mention in a channel is a turn, so its questions went to the channel, command whole. */
  test("from a channel others read, the turn has no commands and no question is put there", async () => {
    const b = bridge()
    const turns = typedTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: ragu,
      sessions: memorySessionStore(),
      remote: () => on,
    })
    b.emit("@bot pulisci la build", { private: false, chat: "canale1" })
    await until("il turno", () => turns.started.length === 1)
    const turn = turns.started[0]!
    // The owner turned the commands on, for private chats: not here.
    expect(turn.request.remote).toEqual({ commands: false })
    turn.request.onPermission!(asking("bash", "rm -rf build"))
    turn.request.onPermission!(asking("external_directory", "C:/Users/me/Documents/*"))
    await until("i due no", () => turn.keys.length === 2)
    expect(turn.keys).toEqual(["reject", "reject"])
    // Nothing asked; one fixed line, with no command, once.
    await until("la riga", () => b.sent.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(b.questions).toHaveLength(0)
    expect(b.sent).toEqual([{ chat: "canale1", text: t("gateway.approve.privateOnly") }])
    expect(JSON.stringify(b.sent)).not.toContain("rm -rf")
    // The same bot in a private chat still asks, on the phone.
    b.emit("pulisci la build", { chat: "d42", id: "p1" })
    await until("il turno privato", () => turns.started.length === 2)
    expect(turns.started[1]!.request.remote).toEqual({ commands: true })
  })

  test("a message that does not say where it came from is a channel", async () => {
    const b = bridge()
    const turns = typedTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: ragu,
      sessions: memorySessionStore(),
      remote: () => on,
    })
    b.emit("ciao", { private: undefined as unknown as boolean })
    await until("il turno", () => turns.started.length === 1)
    expect(turns.started[0]!.request.remote).toEqual({ commands: false })
  })

  test("a Claude or Codex turn has nothing to watch", async () => {
    for (const runner of ["claude", "codex"]) {
      const b = bridge()
      const turns = typedTurns()
      const loadBot = async () => ({ ok: true as const, bot: { ...BOT, runner } })
      await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot, sessions: memorySessionStore() })
      b.emit("ciao")
      await until("il turno", () => turns.started.length === 1)
      expect(turns.started[0]!.request.onPermission).toBeUndefined()
    }
  })

  test("with remote commands on, ragu's question goes to the phone and only a yes from there says yes", async () => {
    const b = bridge()
    const turns = typedTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: ragu,
      sessions: memorySessionStore(),
      remote: () => on,
    })
    b.emit("pulisci la build")
    await until("il turno", () => turns.started.length === 1)
    const turn = turns.started[0]!
    expect(turn.request.remote).toEqual({ commands: true })
    turn.request.onPermission!(asking("bash", "rm -rf build"))
    await until("la domanda", () => b.questions.length === 1)
    const question = b.questions[0]!
    expect(question.chat).toBe("c42")
    // B8c: a dangerous command says why.
    expect(question.text).toBe(
      `${t("gateway.approve.question", "bash", "rm -rf build")}\n${t("gateway.approve.danger", t("bots.approval.reason.recursiveDelete"))}`,
    )
    expect(question.buttons.map((button) => button.label)).toEqual([t("gateway.approve.once"), t("gateway.approve.no")])
    // From another chat, or made up: nothing is typed.
    b.emit(question.buttons[0]!.data, { button: true, chat: "c7" })
    b.emit("0123456789abcdef:0", { button: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turn.keys).toEqual([])
    expect(b.questions).toHaveLength(1)
    b.emit(question.buttons[0]!.data, { button: true })
    await until("il sì", () => turn.keys.length === 1)
    expect(turn.keys).toEqual(["once"])
    // The yes names its own question (B8d review, M1).
    expect(turn.ids).toEqual(["per_rm -rf build"])
    // The next command is asked again: a yes is for one command.
    turn.request.onPermission!(asking("bash", "npm publish"))
    await until("la seconda domanda", () => b.questions.length === 2)
    b.emit(b.questions[1]!.buttons[1]!.data, { button: true })
    await until("il no", () => turn.keys.length === 2)
    expect(turn.keys[1]).toBe("reject")
  })

  /* The user's choice 4: a question waiting on a phone is in the list of what waits, and ADE can decide it. */
  test("a question on the phone is listed for ADE, decided from there, and the phone is told and its buttons stop counting", async () => {
    const registry = createApprovalRegistry()
    const b = bridge()
    const turns = typedTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: ragu,
      sessions: memorySessionStore(),
      remote: () => on,
      approvals: registry,
      now: () => 1_000,
    })
    b.emit("pulisci la build")
    await until("il turno", () => turns.started.length === 1)
    const turn = turns.started[0]!
    turn.request.onPermission!(asking("bash", "rm -rf build"))
    await until("la domanda", () => b.questions.length === 1)

    const [listed] = mergeApprovals(registry.list())
    expect(listed).toMatchObject({
      bot: BOT.path,
      botName: "aiuto",
      permission: "bash",
      patterns: "rm -rf build",
      // The project the gateway runs in: the same command from the panel in another project is another request (P2-1).
      cwd: PROJECT,
      sources: ["telegram"],
      // A standing «Sempre» is not the phone's to give, nor ADE's for the phone.
      choices: ["once", "reject"],
      askedAt: 1_000,
      expiresAt: 1_000 + ASK_TIMEOUT_MS,
    })
    expect(listed!.reason).toBe(t("bots.approval.reason.recursiveDelete"))

    expect(decideApproval(listed!, "once")).toBe(true)
    await until("il sì", () => turn.keys.length === 1)
    expect(turn.keys).toEqual(["once"])
    expect(turn.ids).toEqual(["per_rm -rf build"])
    expect(registry.list()).toEqual([])
    // The phone is told who answered.
    await until("l'esito", () => b.sent.some((line) => line.text === t("gateway.approve.byAdeOnce", "rm -rf build")))

    // The button still on the phone no longer counts, and a second answer from ADE does nothing.
    b.emit(b.questions[0]!.buttons[1]!.data, { button: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turn.keys).toEqual(["once"])
    expect(decideApproval(listed!, "reject")).toBe(true)
    expect(turn.keys).toEqual(["once"])
    expect(b.sent.filter((line) => line.text === t("gateway.approve.byAdeNo", "rm -rf build"))).toEqual([])
    // P2-4: the press that came too late is told so, once; the phone still has the buttons, and a second press says nothing more.
    await until("il già deciso", () => b.sent.some((line) => line.text === t("gateway.approve.alreadyAde")))
    b.emit(b.questions[0]!.buttons[0]!.data, { button: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(b.sent.filter((line) => line.text === t("gateway.approve.alreadyAde"))).toHaveLength(1)
  })

  test("a no from ADE reaches the phone as a no; a press on the phone closes the entry too", async () => {
    const registry = createApprovalRegistry()
    const b = bridge()
    const turns = typedTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: ragu,
      sessions: memorySessionStore(),
      remote: () => on,
      approvals: registry,
    })
    b.emit("pulisci la build")
    await until("il turno", () => turns.started.length === 1)
    const turn = turns.started[0]!
    turn.request.onPermission!(asking("bash", "rm -rf build"))
    await until("la domanda", () => b.questions.length === 1)
    decideApproval(mergeApprovals(registry.list())[0]!, "reject")
    await until("il no", () => turn.keys.length === 1)
    expect(turn.keys).toEqual(["reject"])
    await until("l'esito", () => b.sent.some((line) => line.text === t("gateway.approve.byAdeNo", "rm -rf build")))

    turn.request.onPermission!(asking("bash", "npm publish"))
    await until("la seconda domanda", () => b.questions.length === 2)
    expect(registry.list()).toHaveLength(1)
    b.emit(b.questions[1]!.buttons[0]!.data, { button: true })
    await until("il sì dal telefono", () => turn.keys.length === 2)
    expect(registry.list()).toEqual([])
  })

  test("a press from another person of the chat does not answer the question of the one who asked (S13)", async () => {
    const b = bridge()
    const turns = typedTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: ragu,
      sessions: memorySessionStore(),
      remote: () => on,
    })
    b.emit("pulisci la build")
    await until("il turno", () => turns.started.length === 1)
    const turn = turns.started[0]!
    turn.request.onPermission!(asking("bash", "rm -rf build"))
    await until("la domanda", () => b.questions.length === 1)
    const yes = b.questions[0]!.buttons[0]!.data
    b.emit(yes, { button: true, sender: { id: "99", name: "Altro" } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turn.keys).toEqual([])
    b.emit(yes, { button: true })
    await until("il sì di chi ha chiesto", () => turn.keys.length === 1)
    expect(turn.keys).toEqual(["once"])
  })

  test("no answer in time is a no, and the chat is told", async () => {
    const b = bridge()
    const turns = typedTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: ragu,
      sessions: memorySessionStore(),
      remote: () => on,
      approvalTimeoutMs: 20,
    })
    b.emit("pulisci la build")
    await until("il turno", () => turns.started.length === 1)
    const turn = turns.started[0]!
    turn.request.onPermission!(asking("bash", "rm -rf build"))
    await until("il no allo scadere", () => turn.keys.length === 1)
    expect(turn.keys).toEqual(["reject"])
    await until("l'avviso", () => b.sent.some((sent) => sent.text === t("gateway.approve.expired")))
    // A press after the time is ignored.
    b.emit(b.questions[0]!.buttons[0]!.data, { button: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turn.keys).toEqual(["reject"])
  })

  test("a question still waiting when the turn ends is dropped: nothing typed, a late yes ignored", async () => {
    const b = bridge()
    const turns = typedTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: ragu,
      sessions: memorySessionStore(),
      remote: () => on,
    })
    b.emit("pulisci la build")
    await until("il turno", () => turns.started.length === 1)
    const turn = turns.started[0]!
    turn.request.onPermission!(asking("bash", "rm -rf build"))
    await until("la domanda", () => b.questions.length === 1)
    turn.finish()
    await until("la risposta", () => b.sent.some((sent) => sent.text === "Fatto."))
    b.emit(b.questions[0]!.buttons[0]!.data, { button: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turn.keys).toEqual([])
    expect(b.sent.some((sent) => sent.text === t("gateway.approve.expired"))).toBe(false)
  })

  test("saved on for another version of the bot's file, or for no file, they are off (G5 review, BASSO 1)", async () => {
    for (const saved of [{ commands: true, fingerprint: "f-vecchia" }, { commands: true }]) {
      const b = bridge()
      const turns = typedTurns()
      await startGatewayController({
        bridge: b.fake,
        runTurn: turns.runTurn,
        loadBot: ragu,
        sessions: memorySessionStore(),
        remote: () => saved,
      })
      b.emit("pulisci la build")
      await until("il turno", () => turns.started.length === 1)
      expect(turns.started[0]!.request.remote).toEqual(REMOTE_OFF)
    }
  })

  // Full review 2026-10-06, bots 12: the yes is for the platform of the card it was given on.
  test("a yes given for Telegram does not hold on Discord or Slack", async () => {
    const saved = new Map([[remoteKey(BOT.path, "telegram"), on]])
    const lookup = (bot: string, platform: string) => saved.get(remoteKey(bot, platform)) ?? REMOTE_OFF
    for (const [platform, expected] of [
      ["telegram", { commands: true }],
      ["discord", REMOTE_OFF],
      ["slack", REMOTE_OFF],
    ] as const) {
      const b = bridge()
      const turns = typedTurns()
      await startGatewayController({
        bridge: b.fake,
        runTurn: turns.runTurn,
        loadBot: ragu,
        sessions: memorySessionStore(),
        remote: lookup,
      })
      b.emit("pulisci la build", { platform })
      await until("il turno", () => turns.started.length === 1)
      expect(turns.started[0]!.request.remote).toEqual(expected)
    }
  })

  test("the panel's yes on one platform is not found under another", async () => {
    const store = memoryRemoteStore()
    store.set(remoteKey(BOT.path, "telegram"), on)
    expect(store.get(remoteKey(BOT.path, "telegram"))).toEqual(on)
    expect(store.get(remoteKey(BOT.path, "discord"))).toEqual(REMOTE_OFF)
    // The old key, by the bot alone, is no yes for any platform.
    store.set(BOT.path, on)
    expect(store.get(remoteKey(BOT.path, "telegram"))).toEqual(on)
    expect(remoteTools(store.get(remoteKey(BOT.path, "slack")), "f-1")).toEqual(REMOTE_OFF)
  })

  test("a Claude bot gets them off even when saved on", async () => {
    const b = bridge()
    const turns = typedTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
      remote: () => on,
    })
    b.emit("pulisci la build")
    await until("il turno", () => turns.started.length === 1)
    expect(turns.started[0]!.request.remote).toEqual(REMOTE_OFF)
  })

  test("the remote commands are the bot's own: another bot's setting does not count", async () => {
    const b = bridge()
    const turns = typedTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: ragu,
      sessions: memorySessionStore(),
      remote: (bot) => (bot === "C:/altro.md" ? on : REMOTE_OFF),
    })
    b.emit("pulisci la build")
    await until("il turno", () => turns.started.length === 1)
    expect(turns.started[0]!.request.remote).toBe(REMOTE_OFF)
  })
})

describe("the remote commands saved per bot", () => {
  test("off unless saved on, for one version of the file", () => {
    const key = `ade.gateway.remote.test.${Math.random()}`
    const store = localRemoteStore(key)
    expect(store.get("a.md")).toEqual(REMOTE_OFF)
    store.set("a.md", { commands: true, fingerprint: "f-1" })
    expect(localRemoteStore(key).get("a.md")).toEqual({ commands: true, fingerprint: "f-1" })
    expect(localRemoteStore(key).get("b.md")).toEqual(REMOTE_OFF)
    expect(remoteTools(localRemoteStore(key).get("a.md"), "f-1")).toEqual({ commands: true })
    expect(remoteTools(localRemoteStore(key).get("a.md"), "f-2")).toEqual(REMOTE_OFF)
    expect(remoteTools(localRemoteStore(key).get("a.md"), undefined)).toEqual(REMOTE_OFF)
    // Whatever else is found saved counts as off, on for no file included.
    localStorage.setItem(
      key,
      JSON.stringify({ "a.md": { commands: "yes", fingerprint: "f-1" }, "c.md": true, "d.md": { commands: true } }),
    )
    expect(localRemoteStore(key).get("a.md")).toEqual(REMOTE_OFF)
    expect(localRemoteStore(key).get("c.md")).toEqual(REMOTE_OFF)
    expect(localRemoteStore(key).get("d.md")).toEqual(REMOTE_OFF)
    localStorage.setItem(key, "{")
    expect(localRemoteStore(key).get("a.md")).toEqual(REMOTE_OFF)
    localStorage.removeItem(key)
    const memory = memoryRemoteStore()
    memory.set("a.md", { commands: true, fingerprint: "f-1" })
    expect(memory.get("a.md")).toEqual({ commands: true, fingerprint: "f-1" })
  })

  test("offered for ragu only: Claude Code and Codex cannot ask about each command (G5 review, M1)", () => {
    expect(offersRemoteCommands("ragu")).toBe(true)
    expect(offersRemoteCommands(undefined)).toBe(true)
    expect(offersRemoteCommands("claude")).toBe(false)
    expect(offersRemoteCommands("codex")).toBe(false)
  })
})

describe("what a failed turn says in the chat (S10)", () => {
  const LEAK = "ENOENT: C:/Users/mario/progetto/.ragu/token.json (server 10.0.0.5:4096)"

  test("a failed turn says a fixed text; the detail goes to ADE's own log", async () => {
    const b = bridge()
    const turns = fakeTurns()
    const warned: string[] = []
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
      warn: (line) => void warned.push(line),
    })
    b.emit("ciao")
    await until("il turno", () => turns.started.length === 1)
    turns.started[0]!.finish({ status: "error", problem: LEAK })
    await until("la risposta", () => b.sent.length === 1)
    expect(b.sent[0]!.text).toBe(t("gateway.failed"))
    expect(b.sent[0]!.text).not.toContain("mario")
    expect(b.sent[0]!.text).not.toContain("10.0.0.5")
    expect(warned.some((line) => line.includes(LEAK))).toBe(true)
  })

  test("a turn that throws says the same fixed text", async () => {
    const b = bridge()
    const warned: string[] = []
    await startGatewayController({
      bridge: b.fake,
      runTurn: () => {
        throw new Error(LEAK)
      },
      loadBot: trusted,
      sessions: memorySessionStore(),
      warn: (line) => void warned.push(line),
    })
    b.emit("ciao")
    await until("la risposta", () => b.sent.length === 1)
    expect(b.sent[0]!.text).toBe(t("gateway.failed"))
    expect(warned.some((line) => line.includes(LEAK))).toBe(true)
  })
})

describe("the owner check of a plan's turn (S16)", () => {
  test("a message that says its sender is not the owner is refused on a plan, with the reason", async () => {
    const b = bridge()
    const turns = fakeTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    b.emit("ciao", { owner: false })
    await until("il rifiuto", () => b.sent.length === 1)
    expect(b.sent[0]!.text).toBe(t("gateway.ownerOnly", "Claude Code"))
    expect(turns.started).toHaveLength(0)
  })

  test("an owner's message, or one that says nothing (D92: every paired account is the owner's), runs", async () => {
    const b = bridge()
    const turns = fakeTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    b.emit("uno", { owner: true })
    await until("il primo turno", () => turns.started.length === 1)
    turns.started[0]!.finish({ text: "ok" })
    await until("la risposta", () => b.sent.length === 1)
    b.emit("due")
    await until("il secondo turno", () => turns.started.length === 2)
    turns.started[1]!.finish({ text: "ok" })
  })
})

describe("who a button and a revocation speak for (S13)", () => {
  const target = { bot: BOT.path, platform: "telegram", chat: "c42" }
  const other = { sender: { id: "99", name: "Altro" } }

  test("a question made for a person is answered by that person's press only", async () => {
    const b = bridge()
    const controller = await startGatewayController({
      bridge: b.fake,
      runTurn: fakeTurns().runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    const answer = controller.ask({ ...target, asker: "42" }, "Eseguo?", [{ label: "Sì", value: "yes" }])
    await until("la domanda", () => b.questions.length === 1)
    const data = b.questions[0]!.buttons[0]!.data
    b.emit(data, { button: true, ...other })
    let settled = false
    void answer.then(() => (settled = true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    b.emit(data, { button: true })
    expect(await answer).toBe("yes")
  })

  test("a question made for nobody in particular stays open to the chat, as before", async () => {
    const b = bridge()
    const controller = await startGatewayController({
      bridge: b.fake,
      runTurn: fakeTurns().runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    const answer = controller.ask(target, "Eseguo?", [{ label: "Sì", value: "yes" }])
    await until("la domanda", () => b.questions.length === 1)
    b.emit(b.questions[0]!.buttons[0]!.data, { button: true, ...other })
    expect(await answer).toBe("yes")
  })

  test("a revocation drops the person's queued messages, stops their turn and closes their questions", async () => {
    const b = bridge()
    const turns = fakeTurns()
    const controller = await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    b.emit("prima")
    await until("il turno", () => turns.started.length === 1)
    b.emit("seconda")
    b.emit("terza di un altro", { ...other, id: "x3" })
    await until("le code", () => b.sent.length === 2)
    const answer = controller.ask({ ...target, asker: "42" }, "Eseguo?", [{ label: "Sì", value: "yes" }])
    await until("la domanda", () => b.questions.length === 1)
    controller.revoke(BOT.path, "telegram", "42")
    expect(turns.started[0]!.stopped).toBe(true)
    expect(await answer).toBeUndefined()
    // The other person's message goes on; the revoked one's second never starts.
    await until("il turno dell'altro", () => turns.started.length === 2)
    expect(turns.started[1]!.request.message.endsWith("terza di un altro")).toBe(true)
    turns.started[1]!.finish({ text: "ok" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turns.started).toHaveLength(2)
    // Nothing was said to the revoked person about the turn that stopped.
    expect(b.sent.map((sent) => sent.text)).not.toContain(t("gateway.stopped"))
  })

  test("a revocation of someone else, or of another bot, changes nothing", async () => {
    const b = bridge()
    const turns = fakeTurns()
    const controller = await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    b.emit("prima")
    await until("il turno", () => turns.started.length === 1)
    b.emit("seconda")
    await until("in coda", () => b.sent.length === 1)
    controller.revoke(BOT.path, "telegram", "99")
    controller.revoke("altro-bot", "telegram", "42")
    controller.revoke(BOT.path, "slack", "42")
    expect(turns.started[0]!.stopped).toBe(false)
    turns.started[0]!.finish({ text: "ok" })
    await until("la seconda", () => turns.started.length === 2)
  })
})

describe("the detail of a failed turn stays in ADE, where the panel shows it (S10)", () => {
  test("the last failed turn of a bot's platform is kept, with its time, without a key and not too long", async () => {
    forgetTurnFailures()
    const b = bridge()
    const turns = fakeTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
      now: () => 1_700_000_000_000,
      warn: () => {},
    })
    b.emit("uno")
    await until("il turno", () => turns.started.length === 1)
    turns.started[0]!.finish({ status: "error", problem: "ENOENT: C:/Users/mario/x.json" })
    await until("la risposta", () => b.sent.length === 1)
    expect(turnFailureOf(BOT.path, "telegram")).toEqual({ at: 1_700_000_000_000, detail: "ENOENT: C:/Users/mario/x.json" })
    expect(turnFailureOf(BOT.path, "slack")).toBeUndefined()
    // The next one replaces it; a key in it is hidden; a long one is cut.
    b.emit("due")
    await until("il secondo turno", () => turns.started.length === 2)
    turns.started[1]!.finish({ status: "error", problem: `chiave sk-${"a1B2c3D4".repeat(5)} ${"x".repeat(2000)}` })
    await until("la seconda risposta", () => b.sent.length === 2)
    const kept = turnFailureOf(BOT.path, "telegram")!
    expect(kept.detail).not.toContain("a1B2c3D4")
    expect(kept.detail.length).toBeLessThanOrEqual(600)
    // A turn that goes well takes it away (N7).
    b.emit("tre")
    await until("il terzo turno", () => turns.started.length === 3)
    turns.started[2]!.finish({ text: "ok" })
    await until("la terza risposta", () => b.sent.length === 3)
    expect(turnFailureOf(BOT.path, "telegram")).toBeUndefined()
  })
})

describe("a refusal of the policy tells the chat no local path (S10)", () => {
  test("the chat reads the text without it; the panel keeps the detail", async () => {
    forgetTurnFailures()
    const b = bridge()
    const turns = fakeTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: async () => ({
        ok: false as const,
        problem: "Il progetto non e' ancora ammesso.",
        detail: "Il progetto C:/Users/mario/progetto non e' ancora ammesso.",
      }),
      sessions: memorySessionStore(),
      warn: () => {},
      now: () => 42,
    })
    b.emit("ciao")
    await until("la risposta", () => b.sent.length === 1)
    expect(b.sent[0]!.text).toBe("Il progetto non e' ancora ammesso.")
    expect(turnFailureOf(BOT.path, "telegram")).toEqual({
      at: 42,
      detail: "Il progetto C:/Users/mario/progetto non e' ancora ammesso.",
    })
    // A refusal with nothing more to say leaves the panel as it was.
    forgetTurnFailures()
    b.emit("ancora")
    await until("la seconda risposta", () => b.sent.length === 2)
    expect(turnFailureOf(BOT.path, "telegram")).toBeDefined()
  })
})

describe("the failure shown in the panel goes away when the bot works again (N7)", () => {
  test("the first turn that goes well clears the bot's failure, whatever the platform, and no other bot's", async () => {
    forgetTurnFailures()
    noteTurnFailure("C:/altro.md", "telegram", "di un altro bot", 1)
    noteTurnFailure(BOT.path, "discord", "su un'altra piattaforma", 2)
    const b = bridge()
    const turns = fakeTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
      warn: () => {},
      now: () => 3,
    })
    b.emit("uno")
    await until("il primo turno", () => turns.started.length === 1)
    turns.started[0]!.finish({ status: "error", problem: "rete giù" })
    await until("la risposta", () => b.sent.length === 1)
    expect(turnFailureOf(BOT.path, "telegram")?.detail).toBe("rete giù")
    // A turn that was stopped is not a turn that went well.
    b.emit("due")
    await until("il secondo turno", () => turns.started.length === 2)
    turns.started[1]!.finish({ status: "stopped" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turnFailureOf(BOT.path, "telegram")).toBeDefined()
    b.emit("tre")
    await until("il terzo turno", () => turns.started.length === 3)
    turns.started[2]!.finish({ text: "ok" })
    await until("la risposta riuscita", () => b.sent.length === 2)
    expect(turnFailureOf(BOT.path, "telegram")).toBeUndefined()
    expect(turnFailureOf(BOT.path, "discord")).toBeUndefined()
    expect(turnFailureOf("C:/altro.md", "telegram")?.detail).toBe("di un altro bot")
    forgetTurnFailures()
  })

  test("repeats active telegram draft every 20s during tool execution and approval question", async () => {
    const b = bridge()
    const turns = fakeTurns()
    const RAGU: AgentFile = { ...BOT, runner: "ragu" }
    const raguBot = async () => ({ ok: true as const, bot: RAGU, fingerprint: "f-1" })
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: raguBot,
      sessions: memorySessionStore(),
      remote: () => ({ commands: true, fingerprint: "f-1" }),
      draftKeepAliveMs: 15,
    })
    b.emit("ciao", { private: true })
    await until("il turno è partito", () => turns.started.length === 1)
    const turn = turns.started[0]!

    // Send first preview
    turn.request.onUpdate!({ ...emptyTalk(), streaming: "Inizio della risposta parziale con abbastanza caratteri per superare la soglia minima." })
    await until("prima anteprima inviata", () => b.previews.length === 1)
    expect(b.previews[0]!.text).toContain("Inizio della risposta")

    // Tool runs without text updates: draftKeepAlive fires after 15ms and repeats the same draft
    await until("bozza ripetuta durante strumento lungo", () => b.previews.length >= 2)
    expect(b.previews[1]!.text).toBe(b.previews[0]!.text)

    // Approval question asked
    turn.request.onPermission?.({
      requestID: "per_2",
      permission: "bash",
      patterns: "cargo test",
      askedAt: 0,
    })
    await until("domanda approvazione arrivata", () => b.questions.length === 1)

    // During approval question, draft keep alive continues to repeat
    const countBeforeApprovalWait = b.previews.length
    await until("bozza ripetuta durante attesa approvazione", () => b.previews.length > countBeforeApprovalWait)
    expect(b.previews[b.previews.length - 1]!.text).toBe(b.previews[0]!.text)

    // Finish turn
    turn.finish({ text: "Risposta completata dopo approvazione." })
    await until("messaggio finale inviato", () => b.sent.length === 1)
  })

  test("Point 6: /stato says how long the gateway has been connected, and chat has no restart command", async () => {
    const b = bridge(PROJECT, async () => ({
      connected: true,
      connectedAtMs: new Date(2026, 9, 16, 14, 5).getTime(),
    }))
    const turns = fakeTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: trusted,
      sessions: memorySessionStore(),
    })
    b.emit("/stato")
    await until("stato ricevuto", () => b.sent.length === 1)
    const replyText = b.sent[0]!.text
    expect(replyText).toContain("14:05")
    expect(replyText).toContain(t("gateway.status.idle"))

    // No restart from chat
    expect(chatCommand("/riavvia")).toBeUndefined()
    expect(chatCommand("/restart")).toBeUndefined()
  })
})

