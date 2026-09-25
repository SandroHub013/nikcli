/**
 * The bots' turns from a chat (G4): what happens to a `gateway:message`.
 *
 * Rust holds the connection and lets through only an authorized sender in a
 * private chat (`src-tauri/src/gateway`). Here, in the page, the message
 * becomes a turn of that bot:
 * - one conversation per chat (`session.ts`), continued with the CLI's
 *   session id;
 * - one turn at a time per chat: what arrives meanwhile waits its turn, and
 *   the chat is told it is queued;
 * - `/nuova`, `/ferma`, `/stato`, `/aiuto` act at once, even mid-turn;
 * - the turn runs in the project fixed when the gateway was switched on, with
 *   the bot's file as it is now and only if the user's trust still holds for
 *   it (`policy.ts`); the plan's places are `runTurn`'s (`terms.ts`);
 * - «sta scrivendo» while it runs, and the answer, or why there is none;
 * - a message Rust took a key out of is answered first by saying so;
 * - `ask` puts a question with buttons under a message. A press counts only
 *   for a button ADE sent, from the same chat, while its question waits, and
 *   once: its data carry a random id, since a client can send any data it
 *   likes. Anything else pressed is ignored.
 * - the turn gets the tools of a turn from a chat (G5, `RemoteTools`): no
 *   shell unless the owner turned on the bot's remote commands, and then
 *   nikcli's permission menu becomes a question on the phone (`approval.ts`).
 *
 * Nothing is read from a chat before this listens: `gateway_ready` is called
 * once the listener is in place, and Rust holds every gateway until then.
 */

import { t } from "../../i18n"
import type { AgentFile } from "../nikcli"
import { runnerById } from "../runners"
import type { Turn, TurnRequest } from "../turn"
import { BOT_TURN_TIMEOUT_MS } from "../controller"
import { permissionWatcher } from "./approval"
import { chatCommand, countMessage, CHAT_MESSAGES_PER_HOUR, framedMessage, mayRun } from "./policy"
import type { BotAccount } from "../account"
import { offersRemoteCommands, remoteTools, type RemoteSetting } from "./remote"
import { resumable, sessionKey, type SessionStore } from "./session"
import { gatewayThreadKey, keptThread, type GatewayThreads } from "./threads"

/** `gateway:message`, as Rust emits it. */
export interface GatewayMessage {
  readonly bot: string
  readonly platform: string
  readonly chat: string
  readonly sender: { readonly id: string; readonly name: string }
  readonly text: string
  readonly id: string
  /** A known secret was taken out of the text or the name. */
  readonly redacted: boolean
  /** A button was pressed; `text` is its data. */
  readonly button: boolean
}

/** The Rust side, as the controller sees it. Tests pass a fake. */
export interface GatewayBridge {
  /** Starts listening for `gateway:message`; resolves with the way to stop. */
  listen: (onMessage: (message: GatewayMessage) => void) => Promise<() => void>
  /** Tells Rust the page listens: the gateways may read. */
  ready: () => Promise<void>
  send: (bot: string, platform: string, chat: string, text: string) => Promise<string>
  sendButtons: (bot: string, platform: string, chat: string, text: string, buttons: readonly { label: string; data: string }[]) => Promise<string>
  typing: (bot: string, platform: string, chat: string) => Promise<void>
  /** The project the gateway's turns run in, fixed when it was switched on. */
  project: (bot: string, platform: string) => Promise<string | undefined>
}

export interface GatewayControllerDeps {
  readonly bridge: GatewayBridge
  readonly runTurn: (request: TurnRequest) => Turn
  /** The bot at `path` as its file is now, if its trust still holds (`recheckTrust`). */
  readonly loadBot: (
    path: string,
    project: string,
  ) => Promise<{ ok: true; bot: AgentFile; fingerprint?: string } | { ok: false; problem: string }>
  readonly sessions: SessionStore
  /** The chat's thread on disk, apart from the panel's. Absent in a test that does not keep one. */
  readonly threads?: GatewayThreads
  /** The bot's remote commands as saved (`remote.ts`); off when absent. */
  readonly remote?: (bot: string) => RemoteSetting
  /** The bot's account in ADE (`account.ts`). Absent is a subscription. */
  readonly account?: (bot: string) => BotAccount
  /** How long a command waits for the phone before it is refused; `ASK_TIMEOUT_MS` when absent. */
  readonly approvalTimeoutMs?: number
  readonly now?: () => number
  /** How often «sta scrivendo» is sent again: Telegram shows it for 5 s. */
  readonly typingEveryMs?: number
  /** Where a failure to reach the chat is noted; never the text of a message. */
  readonly warn?: (line: string) => void
}

/** Where a question goes: one chat of one bot's gateway. */
export interface ChatTarget {
  readonly bot: string
  readonly platform: string
  readonly chat: string
}

export interface Choice {
  readonly label: string
  readonly value: string
}

/** How long a question waits for a press before it counts as no answer. */
export const ASK_TIMEOUT_MS = 5 * 60_000

export interface GatewayController {
  /** Stops listening and every turn from a chat; questions still waiting get no answer. */
  stop: () => void
  /**
   * Sends `question` with a button per choice, and resolves with the value of
   * the one pressed; `undefined` when nothing valid was pressed in time, or
   * the question could not be sent.
   */
  ask: (target: ChatTarget, question: string, choices: readonly Choice[], timeoutMs?: number) => Promise<string | undefined>
  /** Chats with a turn running, for tests and the panel. */
  busy: () => string[]
}

interface ChatState {
  readonly queue: GatewayMessage[]
  turn?: Turn
  /** Set while a turn is being prepared, before `turn` exists. */
  starting: boolean
  /** `/ferma` came while the turn was being prepared: it does not start. */
  cancelled: boolean
  times: number[]
  /** The limit was already said in this chat: said once, then silence. */
  limited: boolean
}

const TYPING_EVERY_MS = 4_000

interface Question {
  readonly key: string
  readonly choices: readonly Choice[]
  readonly answer: (value: string | undefined) => void
}

/** 16 hex characters from the platform's random source: what a button's data start with. */
function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function startGatewayController(deps: GatewayControllerDeps): Promise<GatewayController> {
  const now = deps.now ?? Date.now
  const warn = deps.warn ?? ((line: string) => console.warn(line))
  const chats = new Map<string, ChatState>()
  const questions = new Map<string, Question>()
  let closed = false

  /** A press: the answer to a question still waiting in that chat, or nothing. */
  const press = (message: GatewayMessage) => {
    const [id, index] = message.text.split(":")
    const question = id ? questions.get(id) : undefined
    if (!question || question.key !== sessionKey(message.bot, message.platform, message.chat)) return
    const choice = question.choices[Number(index)]
    if (!choice || String(Number(index)) !== index) return
    question.answer(choice.value)
  }

  /** `signal`: the question's turn ended, and the question with it. */
  const ask = (target: ChatTarget, question: string, choices: readonly Choice[], timeoutMs = ASK_TIMEOUT_MS, signal?: AbortSignal) =>
    new Promise<string | undefined>((resolve) => {
      if (closed || choices.length === 0 || signal?.aborted) return resolve(undefined)
      const id = nonce()
      const timer = setTimeout(() => answer(undefined), timeoutMs)
      // Once: whichever comes first — a press, the timeout, the stop, the turn's end — ends it.
      const answer = (value: string | undefined) => {
        if (!questions.delete(id)) return
        clearTimeout(timer)
        signal?.removeEventListener("abort", ended)
        resolve(value)
      }
      const ended = () => answer(undefined)
      signal?.addEventListener("abort", ended)
      questions.set(id, { key: sessionKey(target.bot, target.platform, target.chat), choices, answer })
      const buttons = choices.map((choice, index) => ({ label: choice.label, data: `${id}:${index}` }))
      deps.bridge.sendButtons(target.bot, target.platform, target.chat, question, buttons).catch((error) => {
        warn(`ADE: domanda del gateway non mandata (${target.platform}): ${error instanceof Error ? error.message : String(error)}`)
        answer(undefined)
      })
    })

  const stateOf = (key: string): ChatState => {
    let state = chats.get(key)
    if (!state) {
      state = { queue: [], starting: false, cancelled: false, times: [], limited: false }
      chats.set(key, state)
    }
    return state
  }

  const reply = async (message: GatewayMessage, text: string) => {
    try {
      await deps.bridge.send(message.bot, message.platform, message.chat, text)
    } catch (error) {
      warn(`ADE: risposta del gateway non mandata (${message.platform}): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const command = async (message: GatewayMessage, key: string, which: string) => {
    const state = stateOf(key)
    const running = state.turn !== undefined || state.starting
    if (which === "new") {
      deps.sessions.forget(key)
      deps.threads?.forget(gatewayThreadKey(message.bot, message.platform, message.chat))
      return reply(message, t("gateway.fresh"))
    }
    if (which === "stop") {
      state.queue.length = 0
      if (!running) return reply(message, t("gateway.nothingToStop"))
      if (state.turn) state.turn.stop()
      else state.cancelled = true
      return reply(message, t("gateway.stopped"))
    }
    if (which === "status") {
      return reply(message, running ? t("gateway.status.working", state.queue.length) : t("gateway.status.idle"))
    }
    return reply(message, t("gateway.help"))
  }

  /** The next queued message of `key`'s chat becomes a turn, if none is running. */
  const next = async (key: string): Promise<void> => {
    const state = stateOf(key)
    if (closed || state.turn || state.starting) return
    const message = state.queue.shift()
    if (!message) return
    state.starting = true
    state.cancelled = false
    let typing: ReturnType<typeof setInterval> | undefined
    const ended = new AbortController()
    try {
      const project = await deps.bridge.project(message.bot, message.platform)
      if (!project) return void (await reply(message, t("gateway.noProject")))
      const loaded = await deps.loadBot(message.bot, project)
      if (!loaded.ok) return void (await reply(message, loaded.problem))
      const bot = loaded.bot
      const runner = runnerById(bot.runner).id
      const allowed = mayRun(runner, true)
      if (!allowed.ok) return void (await reply(message, allowed.problem))
      // `/ferma` while the bot was being read: nothing starts.
      if (closed || state.cancelled) return
      const sessionId = resumable(deps.sessions.get(key), project, runner)
      const sendTyping = () => void deps.bridge.typing(message.bot, message.platform, message.chat).catch(() => {})
      sendTyping()
      typing = setInterval(sendTyping, deps.typingEveryMs ?? TYPING_EVERY_MS)
      const remote = remoteTools(offersRemoteCommands(runner) ? deps.remote?.(message.bot) : undefined, loaded.fingerprint)
      let turn: Turn | undefined
      // nikcli stops on its permission menu: answered on the phone, or no at once.
      const onData =
        runner === "nikcli"
          ? permissionWatcher({
              ask: (question, choices, signal) => ask(message, question, choices, deps.approvalTimeoutMs ?? ASK_TIMEOUT_MS, signal),
              refuse: !remote.commands,
              write: (keys) => turn?.write?.(keys),
              say: (text) => void reply(message, text),
              signal: ended.signal,
            })
          : undefined
      turn = deps.runTurn({
        runner,
        bot,
        message: framedMessage(message.platform, message.sender.name, message.text),
        cwd: project,
        timeoutMs: BOT_TURN_TIMEOUT_MS,
        remote,
        account: deps.account?.(message.bot) ?? { mode: "plan" },
        ...(sessionId ? { sessionId } : {}),
        ...(onData ? { onData } : {}),
      })
      state.turn = turn
      state.starting = false
      const result = await turn.result
      clearInterval(typing)
      typing = undefined
      if (result.sessionId) deps.sessions.set(key, { project, runner, sessionId: result.sessionId })
      if (deps.threads && result.talk) {
        const stored = gatewayThreadKey(message.bot, message.platform, message.chat)
        deps.threads.save(stored, keptThread(deps.threads.read(stored), result.talk))
      }
      // A stopped turn was already answered by `/ferma`.
      if (result.status === "stopped") return
      if (result.status === "error") return void (await reply(message, t("gateway.failed", result.problem ?? "?")))
      await reply(message, result.text.trim() ? result.text : t("gateway.empty"))
    } catch (error) {
      await reply(message, t("gateway.failed", error instanceof Error ? error.message : String(error)))
    } finally {
      ended.abort()
      if (typing) clearInterval(typing)
      state.turn = undefined
      state.starting = false
      void next(key)
    }
  }

  const receive = async (message: GatewayMessage) => {
    if (closed) return
    // A press answers a question; it never starts a turn.
    if (message.button) return press(message)
    const key = sessionKey(message.bot, message.platform, message.chat)
    const which = chatCommand(message.text)
    if (which) return command(message, key, which)
    const state = stateOf(key)
    const counted = countMessage(state.times, now())
    state.times = counted.times
    /*
     * Said without waiting for the send: a message that came meanwhile would
     * otherwise be queued first, and answered first (G4 review, BASSO 1).
     */
    if (!counted.allowed) {
      if (!state.limited) {
        state.limited = true
        void reply(message, t("gateway.limit", CHAT_MESSAGES_PER_HOUR))
      }
      return
    }
    state.limited = false
    if (message.redacted) void reply(message, t("gateway.redacted"))
    state.queue.push(message)
    const busy = state.turn !== undefined || state.starting
    if (busy) return reply(message, t("gateway.queued", state.queue.length))
    await next(key)
  }

  const unlisten = await deps.bridge.listen((message) => void receive(message))
  await deps.bridge.ready()

  return {
    stop: () => {
      closed = true
      unlisten()
      for (const state of chats.values()) {
        state.queue.length = 0
        state.turn?.stop()
      }
      for (const question of [...questions.values()]) question.answer(undefined)
    },
    ask,
    busy: () => [...chats.entries()].filter(([, state]) => state.turn || state.starting).map(([key]) => key),
  }
}
