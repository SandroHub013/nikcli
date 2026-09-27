import { describe, expect, test } from "bun:test"
import { t } from "../../i18n"
import type { AgentFile } from "../nikcli"
import { emptyTalk, type PendingPermission } from "../talk"
import { turnsRunning } from "../terms"
import { runTurn, type Turn, type TurnDeps, type TurnRequest, type TurnResult } from "../turn"
import { startGatewayController, type GatewayBridge, type GatewayMessage } from "./controller"
import { chatHeader } from "./policy"
import { localRemoteStore, memoryRemoteStore, offersRemoteCommands, REMOTE_OFF, remoteTools } from "./remote"
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

function bridge(project: string | null = PROJECT) {
  let handler: ((message: GatewayMessage) => void) | undefined
  const calls: string[] = []
  const sent: { chat: string; text: string }[] = []
  const questions: { chat: string; text: string; buttons: readonly { label: string; data: string }[] }[] = []
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
    sendButtons: async (_bot, _platform, chat, text, buttons) => {
      questions.push({ chat, text, buttons })
      return "q"
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
  return { fake, calls, sent, typing, questions, emit }
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

describe("a bot's memory from a chat (B8a review)", () => {
  test("read at the start of a conversation; what the bot writes is only proposed, and leaves its reply", async () => {
    const b = bridge()
    const turns = fakeTurns()
    const memory = volatileMemoryStore()
    memory.set(BOT.path, { notes: ["Il progetto usa bun."], user: [] })
    await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot: trusted, sessions: memorySessionStore(), memory })
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
    expect(first.message).toBe(`${chatHeader("Telegram", "Ale")}\n\nprima domanda`)
    await until("«sta scrivendo» ripetuto", () => b.typing.length >= 2)
    turns.started[0]!.finish({ text: "Prima risposta.", sessionId: "s-1" })
    await until("il secondo turno", () => turns.started.length === 2)
    expect(b.sent.map((sent) => sent.text)).toEqual([t("gateway.queued", 1), "Prima risposta."])
    expect(turns.started[1]!.request.sessionId).toBe("s-1")
    expect(turns.started[1]!.request.message.endsWith("seconda domanda")).toBe(true)
    turns.started[1]!.finish({ status: "error", problem: "rete giù" })
    await until("il motivo", () => b.sent.length === 3)
    expect(b.sent[2]!.text).toBe(t("gateway.failed", "rete giù"))
    expect(sessions.get(sessionKey(BOT.path, "telegram", "c42"))).toEqual({ project: PROJECT, runner: "claude", sessionId: "s-1" })
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

  test("un turno dal gateway porta il flag dell'account", async () => {
    const seen: { flags?: readonly string[]; secrets?: readonly string[] }[] = []
    const machine: TurnDeps = {
      host: async () =>
        ({
          spawn: async (options: { flags?: readonly string[]; secrets?: readonly string[]; onExit: (code: number | null) => void }) => {
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
      talk: { ...emptyTalk(), messages: [{ id: "m1", role: "assistant", text: "ecco", at: 1 }], sessionId: "s-vecchia" },
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
    sessions.set("a", { project: "C:/p", runner: "nikcli", sessionId: "s-1" })
    expect(localSessionStore(storage).get("a")).toEqual({ project: "C:/p", runner: "nikcli", sessionId: "s-1" })
    localStorage.removeItem(storage)
  })

  test("a message a key was taken out of keeps its place: the one after it does not go first", async () => {
    const b = bridge()
    const turns = fakeTurns()
    await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot: trusted, sessions: memorySessionStore() })
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
    const controller = await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot: trusted, sessions: memorySessionStore() })
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
    const controller = await startGatewayController({ bridge: b.fake, runTurn: fakeTurns().runTurn, loadBot: trusted, sessions: memorySessionStore() })
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

/*
 * G5, D93: a turn from a chat has no shell unless the owner turned on the
 * bot's remote commands; then every command nikcli asks about is asked on the
 * phone, and no answer in time is a no.
 */
describe("the tools of a turn from a chat", () => {
  const NIKCLI: AgentFile = { ...BOT, runner: "nikcli" }
  const nikcli = async () => ({ ok: true as const, bot: NIKCLI, fingerprint: "f-1" })
  const on = { commands: true, fingerprint: "f-1" }

  /** A question as nikcli's server event gives it (B8d). */
  const asking = (permission: string, patterns: string): PendingPermission => ({ requestID: `per_${patterns}`, permission, patterns, askedAt: 0 })

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
      return { result, stop: () => entry.finish(), answer: (requestID, reply) => void (entry.keys.push(reply), entry.ids.push(requestID)) }
    }
    return { started, runTurn }
  }

  test("with nothing turned on the turn gets no shell", async () => {
    for (const loadBot of [trusted, nikcli]) {
      const b = bridge()
      const turns = typedTurns()
      await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot, sessions: memorySessionStore() })
      b.emit("pulisci la build")
      await until("il turno", () => turns.started.length === 1)
      expect(turns.started[0]!.request.remote).toEqual({ commands: false })
    }
  })

  /*
   * G5 review, M2: with the commands off nobody was watching nikcli's menu, so
   * any question (outside the project, a `.env`, a loop) left the turn waiting
   * until it timed out, «sta scrivendo» on the phone the whole time.
   */
  test("with the commands off nikcli's every question is answered no at once, and the chat is told once", async () => {
    const b = bridge()
    const turns = typedTurns()
    await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot: nikcli, sessions: memorySessionStore() })
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
    await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot: nikcli, sessions: memorySessionStore(), remote: () => on })
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

  /* B8d: a question is nikcli's event with its id; no output is read, so nothing the model writes can be one. */
  test("a nikcli turn from a chat takes its questions as events", async () => {
    const b = bridge()
    const turns = typedTurns()
    await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot: nikcli, sessions: memorySessionStore(), remote: () => on })
    b.emit("elenca i file")
    await until("il turno", () => turns.started.length === 1)
    const turn = turns.started[0]!
    expect(turn.request.onPermission).toBeDefined()
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

  test("with remote commands on, nikcli's question goes to the phone and only a yes from there says yes", async () => {
    const b = bridge()
    const turns = typedTurns()
    await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot: nikcli, sessions: memorySessionStore(), remote: () => on })
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

  test("no answer in time is a no, and the chat is told", async () => {
    const b = bridge()
    const turns = typedTurns()
    await startGatewayController({
      bridge: b.fake,
      runTurn: turns.runTurn,
      loadBot: nikcli,
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
    await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot: nikcli, sessions: memorySessionStore(), remote: () => on })
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
      await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot: nikcli, sessions: memorySessionStore(), remote: () => saved })
      b.emit("pulisci la build")
      await until("il turno", () => turns.started.length === 1)
      expect(turns.started[0]!.request.remote).toEqual(REMOTE_OFF)
    }
  })

  test("a Claude bot gets them off even when saved on", async () => {
    const b = bridge()
    const turns = typedTurns()
    await startGatewayController({ bridge: b.fake, runTurn: turns.runTurn, loadBot: trusted, sessions: memorySessionStore(), remote: () => on })
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
      loadBot: nikcli,
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
    localStorage.setItem(key, JSON.stringify({ "a.md": { commands: "yes", fingerprint: "f-1" }, "c.md": true, "d.md": { commands: true } }))
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

  test("offered for nikcli only: Claude Code and Codex cannot ask about each command (G5 review, M1)", () => {
    expect(offersRemoteCommands("nikcli")).toBe(true)
    expect(offersRemoteCommands(undefined)).toBe(true)
    expect(offersRemoteCommands("claude")).toBe(false)
    expect(offersRemoteCommands("codex")).toBe(false)
  })
})
