/**
 * The bots' turns from a chat (G4): what happens to a `gateway:message`.
 *
 * Rust holds the connection and lets through only an authorized sender: in a
 * private chat, or in a channel when the message names the bot (G9). A channel
 * is read by others, so a turn from one runs without commands and asks nothing
 * there (S17): the message says whether it came from a private chat. Here, in
 * the page, the message
 * becomes a turn of that bot:
 * - one conversation per chat (`session.ts`), continued with the CLI's
 *   session id;
 * - one turn at a time per chat: what arrives meanwhile waits its turn, and
 *   the chat is told it is queued;
 * - `/nuova`, `/ferma`, `/stato`, `/aiuto` act at once, even mid-turn; `/riprova` asks the last question again, once
 *   the turn before it is over; `/costo` says today's spend, as `/stato` does at its end;
 *   `/modello` shows the model and lets the chat choose another of the bot's own, for that chat alone (`chat-model.ts`);
 *   `/sessioni` lists the last conversations of a private chat and resumes one (`session.ts`, `HistoryStore`);
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
 *   ragu's question, an event with its id on ADE's server (B8d), goes to
 *   the phone (`approval.ts`).
 *
 * Nothing is read from a chat before this listens: `gateway_ready` is called
 * once the listener is in place, and Rust holds every gateway until then.
 */

import { locale, t } from "../../i18n"
import { visibleText } from "../visible-text"
import type { AgentFile } from "../ragu"
import { answerSoFar, runnerById } from "../runners"
import type { Turn, TurnRequest } from "../turn"
import { BOT_TURN_TIMEOUT_MS } from "../controller"
import { memorySnapshot, settleMemoryOps, takeMemoryOps, type MemoryOp, type MemoryStore } from "../memory"
import type { Talk } from "../talk"
import type { ApprovalRegistry } from "../approvals"
import { permissionAnswerer, type AskDetail } from "./approval"
import { forgetTurnFailuresOf, noteTurnFailure } from "./failures"
import { botForChat, modelChoices, type ChatModelStore } from "./chat-model"
import { chatCommand, countMessage, CHAT_MESSAGES_PER_HOUR, framedMessage, mayRun } from "./policy"
import type { BotAccount } from "../account"
import { offersRemoteCommands, REMOTE_OFF, remoteTools, type RemoteSetting } from "./remote"
import { resumable, sessionKey, sessionTitle, type ChatSession, type HistoryStore, type SessionStore } from "./session"
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
  /** A one-to-one chat with the bot. Anything else is a channel others read. */
  readonly private: boolean
  /**
   * The sender is the owner of the account the bot runs on. Rust does not send
   * it yet, and only the owner's own accounts are paired (D92), so a message
   * that says nothing counts as the owner's; `false` is refused on a plan (S16).
   */
  readonly owner?: boolean
  /** The message was recovered after an ADE restart or reload. */
  readonly recovered?: boolean
}

/**
 * Notice prepended to the model prompt when a message was delivered after an ADE restart.
 */
export function recoveredNotice(): string {
  return t("gateway.recoveredNotice")
}

export const RECOVERED_NOTICE = t("gateway.recoveredNotice")

/** The Rust side, as the controller sees it. Tests pass a fake. */
export interface GatewayBridge {
  /** Starts listening for `gateway:message`; resolves with the way to stop. */
  listen: (onMessage: (message: GatewayMessage) => void) => Promise<() => void>
  /** Tells Rust the page listens: the gateways may read. */
  ready: () => Promise<void>
  /** Tells Rust the message was delivered to the frontend, so the cursor can advance. */
  ack?: (bot: string, platform: string, chat: string, id: string) => Promise<void>
  send: (
    bot: string,
    platform: string,
    chat: string,
    text: string,
    options?: { final?: boolean; previewFallback?: string },
  ) => Promise<string>
  sendButtons: (
    bot: string,
    platform: string,
    chat: string,
    text: string,
    buttons: readonly { label: string; data: string }[],
  ) => Promise<string>
  typing: (bot: string, platform: string, chat: string) => Promise<void>
  /** Sends live partial text preview to the chat. */
  preview?: (bot: string, platform: string, chat: string, text: string) => Promise<void>
  /** Ends or cleans up active preview for the chat. */
  previewEnd?: (bot: string, platform: string, chat: string, fallback?: string) => Promise<void>
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
  ) => Promise<{ ok: true; bot: AgentFile; fingerprint?: string } | { ok: false; problem: string; detail?: string }>
  readonly sessions: SessionStore
  /** The conversations a chat left behind, for `/sessioni`. Absent, `/nuova` leaves none to resume. */
  readonly history?: HistoryStore
  /** The chat's thread on disk, apart from the panel's. Absent in a test that does not keep one. */
  readonly threads?: GatewayThreads
  /** The bot's remote commands as saved (`remote.ts`); off when absent. */
  readonly remote?: (bot: string, platform: string) => RemoteSetting
  /** The bot's account in ADE (`account.ts`). Absent is a subscription. */
  readonly account?: (bot: string) => BotAccount
  /**
   * Each bot's memory (B8a review): read at the start of a chat's
   * conversation, as in ADE, and never written from here. What the bot
   * writes from a chat is proposed, for the user to confirm in ADE: a chat's
   * text is someone else's. Absent, the bots have none here.
   */
  readonly memory?: MemoryStore
  /**
   * The bot's money today for `/stato` and `/costo` (`spend.ts`): «Oggi 0,42 $ di 2,00 $.»; absent or undefined, not said.
   * `model` is the one the chat chose with `/modello`, if any: it can be paid when the bot's own is not.
   */
  readonly spendToday?: (bot: string, model?: string) => Promise<string | undefined>
  /** The model each chat chose with `/modello` (`chat-model.ts`); absent, `/modello` only shows the bot's. */
  readonly chatModels?: ChatModelStore
  /** ragu's models for `/modello`: its ids (`provider/model`), of which only the free ones are offered. */
  readonly modelCatalog?: (project: string) => Promise<readonly string[]>
  /** How long a command waits for the phone before it is refused; `ASK_TIMEOUT_MS` when absent. */
  readonly approvalTimeoutMs?: number
  /** Where a question waiting on a phone is listed, so ADE can decide it too (`approvals.ts`); absent, only the phone can. */
  readonly approvals?: ApprovalRegistry
  readonly now?: () => number
  /** How often «sta scrivendo» is sent again: Telegram shows it for 5 s. */
  readonly typingEveryMs?: number
  /** How often preview updates can be sent; `PREVIEW_CADENCE_MS` when absent. */
  readonly previewCadenceMs?: number
  /** Minimum new characters to trigger a preview update; `PREVIEW_MIN_DELTA_CHARS` when absent. */
  readonly previewMinDeltaChars?: number
  /** How often Telegram drafts are refreshed to avoid disappearing; `TELEGRAM_DRAFT_KEEP_ALIVE_MS` when absent. */
  readonly draftKeepAliveMs?: number
  /** Where a failure to reach the chat is noted; never the text of a message. */
  readonly warn?: (line: string) => void
}

export const PREVIEW_CADENCE_MS = 1_000
export const PREVIEW_CADENCE_DISCORD_MS = 2_000
export const PREVIEW_CADENCE_TELEGRAM_MS = 1_000
export const PREVIEW_MIN_DELTA_CHARS = 24
export const PREVIEW_FLOOD_LIMIT = 3
export const TELEGRAM_DRAFT_KEEP_ALIVE_MS = 20_000

/** Where a question goes: one chat of one bot's gateway. */
export interface ChatTarget {
  readonly bot: string
  readonly platform: string
  readonly chat: string
  /**
   * The sender the question is for: only that person's press answers it (S13).
   * Absent, any sender of the chat may answer.
   */
  readonly asker?: string
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
  ask: (
    target: ChatTarget,
    question: string,
    choices: readonly Choice[],
    timeoutMs?: number,
  ) => Promise<string | undefined>
  /**
   * `sender` was revoked: their queued messages are dropped, their turn is
   * stopped without a word to them, and their questions close with no answer.
   */
  revoke: (bot: string, platform: string, sender: string) => void
  /** Chats with a turn running, for tests and the panel. */
  busy: () => string[]
}

interface ChatState {
  readonly queue: GatewayMessage[]
  /** The message the running (or starting) turn answers. */
  current?: GatewayMessage
  turn?: Turn
  /** Set while a turn is being prepared, before `turn` exists. */
  starting: boolean
  /** `/ferma` came while the turn was being prepared: it does not start. */
  cancelled: boolean
  times: number[]
  /** The limit was already said in this chat: said once, then silence. */
  limited: boolean
  /** The last message that became a turn: what `/riprova` asks again. */
  last?: GatewayMessage
  /**
   * How many times `/nuova` was said. A turn that was running when it came
   * must not write its session and thread back at its end: the next message
   * went on with the conversation the user had just dropped (review area 2).
   */
  fresh: number
  /** How many times `/riprova` was said: what makes the ids of its messages different. */
  retries: number
}

const TYPING_EVERY_MS = 4_000

/** What a message made by `/riprova` has in its id: Rust never saw it, so it is not acknowledged. */
const RETRY_MARK = ":retry:"

/** What a question on the phone is about, and whose bot it is: the entry it has in the list of what waits. */
interface ApprovalDetail extends AskDetail {
  readonly botName: string
  /** The project the turn runs in: the same command in another project is another request. */
  readonly cwd: string
}

interface Question {
  readonly key: string
  readonly target: ChatTarget
  readonly choices: readonly Choice[]
  readonly answer: (value: string | undefined) => void
  /** The question lists its choices by number, and a bare number typed in the chat answers it as a press does. */
  readonly numbered: boolean
}

/** How long a list `/modello` or `/sessioni` makes waits for a choice. */
export const PICK_TIMEOUT_MS = 2 * 60_000

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
  /**
   * The questions ADE decided while their buttons were still on the phone, by id: a press on one of them is told it
   * was decided in ADE, once (the phone cannot take the buttons away; it keeps them). A short list: the oldest go.
   */
  const decidedInAde = new Map<string, string>()
  let closed = false

  /** A press: the answer to a question still waiting in that chat, or nothing. */
  const press = (message: GatewayMessage) => {
    const [id, index] = message.text.split(":")
    const question = id ? questions.get(id) : undefined
    if (!question && id && decidedInAde.get(id) === sessionKey(message.bot, message.platform, message.chat)) {
      decidedInAde.delete(id)
      deps.bridge.send(message.bot, message.platform, message.chat, t("gateway.approve.alreadyAde")).catch(() => {})
      return
    }
    if (!question || question.key !== sessionKey(message.bot, message.platform, message.chat)) return
    // A question made for a person is answered by that person (S13).
    if (question.target.asker !== undefined && question.target.asker !== message.sender.id) return
    const choice = question.choices[Number(index)]
    if (!choice || String(Number(index)) !== index) return
    question.answer(choice.value)
  }

  /** `signal`: the question's turn ended, and the question with it. */
  const ask = (
    target: ChatTarget,
    question: string,
    choices: readonly Choice[],
    timeoutMs = ASK_TIMEOUT_MS,
    signal?: AbortSignal,
    detail?: ApprovalDetail,
    options?: { readonly numbered?: boolean },
  ) =>
    new Promise<string | undefined>((resolve) => {
      if (closed || choices.length === 0 || signal?.aborted) return resolve(undefined)
      const id = nonce()
      const timer = setTimeout(() => answer(undefined), timeoutMs)
      let unlist: (() => void) | undefined
      // Once: whichever comes first — a press, the timeout, the stop, the turn's end — ends it.
      const answer = (value: string | undefined) => {
        if (!questions.delete(id)) return
        clearTimeout(timer)
        unlist?.()
        signal?.removeEventListener("abort", ended)
        resolve(value)
      }
      // ADE can answer it too, from the list of what waits: the phone is told, and its buttons stop counting.
      if (detail && deps.approvals) {
        const asked = now()
        unlist = deps.approvals.open({
          key: `${target.platform}:${target.bot}:${id}`,
          bot: target.bot,
          botName: detail.botName,
          source: target.platform,
          permission: detail.permission,
          patterns: detail.patterns,
          cwd: detail.cwd,
          ...(detail.reason ? { reason: detail.reason } : {}),
          askedAt: asked,
          expiresAt: asked + timeoutMs,
          choices: ["once", "reject"],
          answer: (choice) => {
            if (!questions.has(id)) return
            const value = choice === "once" ? "once" : "reject"
            answer(value)
            const command = visibleText(detail.patterns.trim()) || "?"
            const told = t(value === "once" ? "gateway.approve.byAdeOnce" : "gateway.approve.byAdeNo", command)
            decidedInAde.set(id, sessionKey(target.bot, target.platform, target.chat))
            if (decidedInAde.size > 50) decidedInAde.delete(decidedInAde.keys().next().value!)
            deps.bridge.send(target.bot, target.platform, target.chat, told).catch(() => {})
          },
        })
      }
      const ended = () => answer(undefined)
      signal?.addEventListener("abort", ended)
      const numbered = options?.numbered === true
      questions.set(id, {
        key: sessionKey(target.bot, target.platform, target.chat),
        target,
        choices,
        answer,
        numbered,
      })
      const buttons = choices.map((choice, index) => ({ label: choice.label, data: `${id}:${index}` }))
      deps.bridge.sendButtons(target.bot, target.platform, target.chat, question, buttons).catch((error) => {
        warn(
          `ADE: domanda del gateway non mandata (${target.platform}): ${error instanceof Error ? error.message : String(error)}`,
        )
        // A list the text numbers can be answered without buttons: the same words as a plain message, and the number.
        if (!numbered) return answer(undefined)
        deps.bridge.send(target.bot, target.platform, target.chat, question).catch(() => answer(undefined))
      })
    })

  const stateOf = (key: string): ChatState => {
    let state = chats.get(key)
    if (!state) {
      state = { queue: [], starting: false, cancelled: false, times: [], limited: false, fresh: 0, retries: 0 }
      chats.set(key, state)
    }
    return state
  }

  const reply = async (
    message: GatewayMessage,
    text: string,
    options?: { final?: boolean; previewFallback?: string },
  ) => {
    try {
      await deps.bridge.send(message.bot, message.platform, message.chat, text, options)
    } catch (error) {
      warn(
        `ADE: risposta del gateway non mandata (${message.platform}): ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** Why a turn failed, for ADE's own log; never for the chat. */
  const failure = (message: GatewayMessage, problem: string) => {
    warn(`ADE: turno del gateway non riuscito (${message.platform}): ${problem}`)
    // The gateway panel shows the last one of this bot, where the owner can read it (S10).
    noteTurnFailure(message.bot, message.platform, problem, now())
  }

  /** Where a past conversation's thread is kept: the chat's thread key with the session id after it. */
  const pastThreadKey = (message: GatewayMessage, sessionId: string) =>
    gatewayThreadKey(message.bot, message.platform, message.chat, sessionId)

  /**
   * The conversation the chat is in, kept to resume with `/sessioni` before `/nuova` or another choice drops it: its CLI
   * session, and the thread ADE shows. What the cap pushes out of the history goes with its thread.
   */
  const keepPast = (message: GatewayMessage, key: string) => {
    const current = deps.sessions.get(key)
    if (!current || !deps.history) return
    const thread = deps.threads?.read(gatewayThreadKey(message.bot, message.platform, message.chat))
    if (thread && thread.messages.length > 0) deps.threads?.save(pastThreadKey(message, current.sessionId), thread)
    for (const gone of deps.history.add(key, current)) deps.threads?.forget(pastThreadKey(message, gone.sessionId))
  }

  /** A conversation as `/sessioni` lists it: «its first words» and when it last had a turn. */
  const describeSession = (past: ChatSession) => {
    const title = past.title || t("gateway.sessions.untitled")
    if (past.at === undefined) return `«${title}»`
    const when = new Intl.DateTimeFormat(locale() === "it" ? "it-IT" : "en-US", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(past.at)
    return t("gateway.sessions.item", title, when)
  }

  /**
   * `/sessioni`: the last conversations of this chat, and the one the person picks becomes the chat's own again. Only in
   * a private chat (the first words of each are shown), and not while a turn runs.
   */
  const chooseSession = async (message: GatewayMessage, key: string) => {
    if (message.private !== true) return reply(message, t("gateway.sessions.private"))
    const state = stateOf(key)
    const busy = () => state.turn !== undefined || state.starting
    if (busy()) return reply(message, t("gateway.sessions.busy"))
    const past = deps.history?.list(key) ?? []
    const current = deps.sessions.get(key)
    if (past.length === 0) return reply(message, t("gateway.sessions.none"))
    const picked = await ask(
      { bot: message.bot, platform: message.platform, chat: message.chat, asker: message.sender.id },
      t(
        "gateway.sessions.ask",
        current ? t("gateway.sessions.now", describeSession(current)) : "",
        numberedList(past.map(describeSession)),
      ),
      past.map((each, index) => ({
        label: `${index + 1}. ${each.title || t("gateway.sessions.untitled")}`,
        value: each.sessionId,
      })),
      PICK_TIMEOUT_MS,
      undefined,
      undefined,
      { numbered: true },
    )
    if (picked === undefined) return
    const chosen = deps.history?.list(key).find((each) => each.sessionId === picked)
    if (!chosen) return
    if (busy()) return reply(message, t("gateway.sessions.busy"))
    // Resumed only where it can be: the project the gateway runs in now, and the CLI the bot is on now.
    const project = await deps.bridge.project(message.bot, message.platform)
    if (!project) return reply(message, t("gateway.noProject"))
    const loaded = await deps.loadBot(message.bot, project)
    if (!loaded.ok) return reply(message, loaded.problem)
    if (!resumable(chosen, project, runnerById(loaded.bot.runner).id))
      return reply(message, t("gateway.sessions.other", chosen.title || t("gateway.sessions.untitled")))
    if (busy()) return reply(message, t("gateway.sessions.busy"))
    state.fresh += 1
    const thread = deps.threads?.read(pastThreadKey(message, chosen.sessionId))
    deps.history?.remove(key, chosen.sessionId)
    keepPast(message, key)
    deps.sessions.set(key, chosen)
    const stored = gatewayThreadKey(message.bot, message.platform, message.chat)
    if (thread && thread.messages.length > 0) deps.threads?.save(stored, thread)
    else deps.threads?.forget(stored)
    deps.threads?.forget(pastThreadKey(message, chosen.sessionId))
    return reply(message, t("gateway.sessions.resumed", chosen.title || t("gateway.sessions.untitled")))
  }

  /** The list of `lines` as the text of a question: one per line, numbered from 1. */
  const numberedList = (lines: readonly string[]) => lines.map((line, index) => `${index + 1}. ${line}`).join("\n")

  /**
   * `/modello`: the model this chat runs the bot on, and the bot's own to choose from; the choice holds for this chat
   * from its next message on, and is kept across `/nuova`.
   */
  const chooseModel = async (message: GatewayMessage, key: string) => {
    const project = await deps.bridge.project(message.bot, message.platform)
    if (!project) return reply(message, t("gateway.noProject"))
    const loaded = await deps.loadBot(message.bot, project)
    if (!loaded.ok) return reply(message, loaded.problem)
    const bot = loaded.bot
    const runner = runnerById(bot.runner)
    const saved = deps.chatModels?.get(key)
    const chosen = saved && saved.runner === runner.id ? saved.model : undefined
    const own = bot.model ?? ""
    const named = (model: string) => model || t("gateway.model.default", runner.label)
    const current = chosen ?? own
    if (!deps.chatModels) return reply(message, t("gateway.model.only", named(current)))
    const catalog = runner.id === "ragu" ? await (deps.modelCatalog?.(project) ?? Promise.resolve([])).catch(() => []) : []
    // The bot's own model comes first; without one, the way back to the CLI's default is there once another was chosen.
    const options = modelChoices(bot, catalog)
    if (!own && chosen !== undefined) options.unshift("")
    if (options.length === 0) return reply(message, t("gateway.model.nothing", named(current)))
    const marked = options.map((model) => {
      const tags = [model === current ? t("gateway.model.tagCurrent") : "", model === own ? t("gateway.model.tagOwn") : ""]
      return [named(model), ...tags.filter(Boolean).map((tag) => `(${tag})`)].join(" ")
    })
    const picked = await ask(
      { bot: message.bot, platform: message.platform, chat: message.chat, asker: message.sender.id },
      t("gateway.model.ask", named(current), numberedList(marked), runner.id === "ragu" ? t("gateway.model.freeOnly") : ""),
      options.map((model, index) => ({ label: `${index + 1}. ${named(model)}`, value: model })),
      PICK_TIMEOUT_MS,
      undefined,
      undefined,
      { numbered: true },
    )
    if (picked === undefined) return
    if (picked === own) deps.chatModels.forget(key)
    else deps.chatModels.set(key, { runner: runner.id, model: picked })
    return reply(message, t("gateway.model.set", named(picked)))
  }

  const command = async (message: GatewayMessage, key: string, which: string) => {
    const state = stateOf(key)
    const running = state.turn !== undefined || state.starting
    if (which === "new") {
      state.fresh += 1
      keepPast(message, key)
      deps.sessions.forget(key)
      deps.threads?.forget(gatewayThreadKey(message.bot, message.platform, message.chat))
      return reply(message, t("gateway.fresh"))
    }
    if (which === "stop") {
      state.queue.length = 0
      if (!running) return reply(message, t("gateway.nothingToStop"))
      if (state.turn) {
        state.cancelled = true
        state.turn.stop()
      } else {
        state.cancelled = true
      }
      return reply(message, t("gateway.stopped"))
    }
    if (which === "retry") {
      if (running) return reply(message, t("gateway.retry.busy"))
      const last = state.last
      if (!last) return reply(message, t("gateway.retry.none"))
      // It counts like any message: a loop of `/riprova` is a loop of turns.
      const counted = countMessage(state.times, now())
      state.times = counted.times
      if (!counted.allowed) return reply(message, t("gateway.limit", CHAT_MESSAGES_PER_HOUR))
      state.retries += 1
      // The same words, asked by whoever said `/riprova`: the answers to a question on the phone are theirs.
      state.queue.push({
        ...last,
        id: `${last.id}${RETRY_MARK}${state.retries}`,
        sender: message.sender,
        ...(message.owner === undefined ? {} : { owner: message.owner }),
        private: message.private,
        redacted: false,
        recovered: false,
      })
      void reply(message, t("gateway.retry.again"))
      return next(key)
    }
    if (which === "cost") {
      const spent = await deps.spendToday?.(message.bot, deps.chatModels?.get(key)?.model).catch(() => undefined)
      return reply(message, spent ?? t("gateway.cost.none"))
    }
    if (which === "model") return chooseModel(message, key)
    if (which === "sessions") return chooseSession(message, key)
    if (which === "status") {
      const said = running ? t("gateway.status.working", state.queue.length) : t("gateway.status.idle")
      const spent = await deps.spendToday?.(message.bot, deps.chatModels?.get(key)?.model).catch(() => undefined)
      return reply(message, spent ? `${said}\n${spent}` : said)
    }
    return reply(message, t("gateway.help"))
  }

  /** The next queued message of `key`'s chat becomes a turn, if none is running. */
  const next = async (key: string): Promise<void> => {
    const state = stateOf(key)
    if (closed || state.turn || state.starting) return
    const message = state.queue.shift()
    if (!message) return
    if (!message.id.includes(RETRY_MARK))
      void deps.bridge.ack?.(message.bot, message.platform, message.chat, message.id)?.catch?.(() => {})
    state.last = message
    state.starting = true
    state.cancelled = false
    state.current = message
    const fresh = state.fresh
    let typing: ReturnType<typeof setInterval> | undefined
    let draftKeepAlive: ReturnType<typeof setInterval> | undefined
    let inFlightPreview: Promise<void> | undefined
    let previewDisabled = false
    const ended = new AbortController()
    try {
      const project = await deps.bridge.project(message.bot, message.platform)
      if (!project) return void (await reply(message, t("gateway.noProject")))
      const loaded = await deps.loadBot(message.bot, project)
      if (!loaded.ok) {
        // The chat reads `problem`, which has no local path; the panel keeps `detail` (S10).
        if (loaded.detail) failure(message, loaded.detail)
        return void (await reply(message, loaded.problem))
      }
      const bot = botForChat(loaded.bot, deps.chatModels?.get(key))
      const runner = runnerById(bot.runner).id
      const allowed = mayRun(runner, message.owner !== false)
      if (!allowed.ok) return void (await reply(message, allowed.problem))
      // `/ferma` while the bot was being read: nothing starts.
      if (closed || state.cancelled) return
      const sessionId = resumable(deps.sessions.get(key), project, runner)
      const sendTyping = () => void deps.bridge.typing(message.bot, message.platform, message.chat).catch(() => {})
      sendTyping()
      typing = setInterval(sendTyping, deps.typingEveryMs ?? TYPING_EVERY_MS)
      // A channel others read: no commands there, and no question, whoever asked in it (S17). Anything but a
      // private chat counts, so a message that does not say is treated as a channel.
      const publicChat = message.private !== true
      const remote = publicChat
        ? REMOTE_OFF
        : remoteTools(
            offersRemoteCommands(runner) ? deps.remote?.(message.bot, message.platform) : undefined,
            loaded.fingerprint,
          )
      let turn: Turn | undefined
      let pendingApproval = false
      // ragu's questions, by their id on ADE's server (B8d): answered on the phone, or no at once.
      const onPermission =
        runner === "ragu"
          ? permissionAnswerer({
              ask: async (question, choices, signal, detail) => {
                pendingApproval = true
                try {
                  return await ask(
                    { bot: message.bot, platform: message.platform, chat: message.chat, asker: message.sender.id },
                    question,
                    choices,
                    deps.approvalTimeoutMs ?? ASK_TIMEOUT_MS,
                    signal,
                    detail && { ...detail, botName: bot.identifier, cwd: project },
                  )
                } finally {
                  pendingApproval = false
                }
              },
              refuse: !remote.commands,
              publicChat,
              answer: (requestID, reply) => {
                if (requestID !== undefined) turn?.answer?.(requestID, reply)
              },
              say: (text) => void reply(message, text),
              signal: ended.signal,
            })
          : undefined
      const baseFramed = framedMessage(message.platform, message.sender.name, message.text)
      const framed = message.recovered ? `${recoveredNotice()}\n\n${baseFramed}` : baseFramed
      const memory = deps.memory?.get(message.bot)
      const sent = memory && !sessionId ? `${memorySnapshot(memory)}\n\n${framed}` : framed

      let lastPreviewAt = 0
      let lastPreviewText = ""
      let floodErrors = 0
      let previewing = false

      const defaultCadence = message.platform === "discord" ? PREVIEW_CADENCE_DISCORD_MS : PREVIEW_CADENCE_TELEGRAM_MS
      const cadenceMs = deps.previewCadenceMs ?? defaultCadence
      const minDeltaChars = deps.previewMinDeltaChars ?? PREVIEW_MIN_DELTA_CHARS

      const sendPreview = (text: string) => {
        const previewFn = deps.bridge.preview
        if (closed || previewDisabled || pendingApproval || state.cancelled || ended.signal.aborted || !previewFn) return
        const currentTime = now()
        if (currentTime - lastPreviewAt < cadenceMs) return
        if (text.length - lastPreviewText.length < minDeltaChars) return
        if (previewing) return

        previewing = true
        lastPreviewAt = currentTime
        lastPreviewText = text
        const promise = (async () => {
          try {
            if (closed || previewDisabled || pendingApproval || state.cancelled || ended.signal.aborted) return
            await previewFn(message.bot, message.platform, message.chat, text)
          } catch (error) {
            if (isFloodError(error)) {
              floodErrors += 1
              if (floodErrors >= PREVIEW_FLOOD_LIMIT) {
                previewDisabled = true
              }
            }
          } finally {
            previewing = false
          }
        })()
        inFlightPreview = promise
      }

      if (message.platform === "telegram") {
        const keepAliveMs = deps.draftKeepAliveMs ?? TELEGRAM_DRAFT_KEEP_ALIVE_MS
        draftKeepAlive = setInterval(() => {
          const previewFn = deps.bridge.preview
          if (closed || previewDisabled || state.cancelled || ended.signal.aborted || !previewFn) return
          if (!lastPreviewText) return
          if (previewing) return
          previewing = true
          const textToRefresh = lastPreviewText
          const promise = (async () => {
            try {
              if (closed || previewDisabled || state.cancelled || ended.signal.aborted) return
              await previewFn(message.bot, message.platform, message.chat, textToRefresh)
            } catch (error) {
              if (isFloodError(error)) {
                floodErrors += 1
                if (floodErrors >= PREVIEW_FLOOD_LIMIT) {
                  previewDisabled = true
                }
              }
            } finally {
              previewing = false
            }
          })()
          inFlightPreview = promise
        }, keepAliveMs)
      }

      turn = deps.runTurn({
        runner,
        bot,
        message: sent,
        cwd: project,
        timeoutMs: BOT_TURN_TIMEOUT_MS,
        remote,
        account: deps.account?.(message.bot) ?? { mode: "plan" },
        partial: true,
        onUpdate: (talk) => {
          const raw = answerSoFar(talk)
          if (raw) {
            const text = safePreviewText(takeMemoryOps(raw).text)
            if (text) {
              void sendPreview(text)
            }
          }
        },
        ...(sessionId ? { sessionId } : {}),
        ...(onPermission ? { onPermission } : {}),
      })
      state.turn = turn
      state.starting = false
      const result = await turn.result
      previewDisabled = true
      if (inFlightPreview) {
        try {
          await inFlightPreview
        } catch {}
      }
      if (draftKeepAlive) {
        clearInterval(draftKeepAlive)
        draftKeepAlive = undefined
      }
      clearInterval(typing)
      typing = undefined
      const kept = state.fresh === fresh
      if (kept && result.sessionId) {
        // The conversation keeps the words it began with; a new one begins with these.
        const began = sessionId ? deps.sessions.get(key)?.title : undefined
        deps.sessions.set(key, {
          project,
          runner,
          sessionId: result.sessionId,
          title: began ?? sessionTitle(message.text),
          at: now(),
        })
      }
      const said = settleChatMemory(message.bot, result.talk, sent, framed)
      const text = said.found ? takeMemoryOps(result.text).text : result.text
      if (kept && deps.threads && result.talk) {
        const stored = gatewayThreadKey(message.bot, message.platform, message.chat)
        deps.threads.save(stored, keptThread(deps.threads.read(stored), said.talk))
      }
      // A stopped turn was already answered by `/ferma`.
      if (result.status === "stopped") return
      // The chat reads a fixed text: the detail (local paths, the server's words) stays in ADE (S10).
      if (result.status === "error") {
        failure(message, result.problem ?? "?")
        return void (await reply(message, t("gateway.failed"), {
          final: true,
          previewFallback: t("gateway.preview.sentBelow"),
        }))
      }
      // The bot works: what the panel kept of an earlier failure goes (N7).
      forgetTurnFailuresOf(message.bot)
      await reply(message, text.trim() ? text : t("gateway.empty"), {
        final: true,
        previewFallback: t("gateway.preview.sentBelow"),
      })
    } catch (error) {
      failure(message, error instanceof Error ? error.message : String(error))
      await reply(message, t("gateway.failed"), {
        final: true,
        previewFallback: t("gateway.preview.sentBelow"),
      })
    } finally {
      previewDisabled = true
      if (inFlightPreview) {
        try {
          await inFlightPreview
        } catch {}
      }
      try {
        await deps.bridge.previewEnd?.(message.bot, message.platform, message.chat, t("gateway.preview.interrupted"))
      } catch {}
      ended.abort()
      if (typing) clearInterval(typing)
      if (draftKeepAlive) clearInterval(draftKeepAlive)
      state.turn = undefined
      state.starting = false
      state.current = undefined
      void next(key)
    }
  }

  /**
   * A chat's turn and its memory (B8a review): the tags leave the bot's words
   * and become proposals, and the thread kept in ADE shows the chat's message
   * without the snapshot put before it.
   */
  const settleChatMemory = (bot: string, talk: Talk, sent: string, framed: string): { talk: Talk; found: boolean } => {
    const store = deps.memory
    if (!store) return { talk, found: false }
    const ops: MemoryOp[] = []
    let found = false
    const messages = talk.messages
      .map((entry) => {
        if (entry.role === "user" && entry.text === sent) return { ...entry, text: framed }
        if (entry.role !== "bot") return entry
        const taken = takeMemoryOps(entry.text)
        if (taken.ops.length === 0 && taken.unreadable === 0) return entry
        found = true
        ops.push(...taken.ops)
        return { ...entry, text: taken.text }
      })
      .filter((entry) => !(entry.role === "bot" && entry.text.length === 0))
    if (ops.length > 0) {
      const { memory } = settleMemoryOps(store.get(bot), ops, () => crypto.randomUUID(), {
        propose: () => true,
        from: "gateway",
        at: (deps.now ?? Date.now)(),
      })
      store.set(bot, memory)
    }
    return { talk: { ...talk, messages }, found }
  }

  const SEEN_MESSAGES_CAP = 1_000
  const seenMessages = new Set<string>()
  const seenMessagesOrder: string[] = []

  const isDuplicate = (m: GatewayMessage): boolean => {
    const key = `${m.bot}:${m.platform}:${m.chat}:${m.id}`
    if (seenMessages.has(key)) return true
    if (seenMessagesOrder.length >= SEEN_MESSAGES_CAP) {
      const oldest = seenMessagesOrder.shift()
      if (oldest) seenMessages.delete(oldest)
    }
    seenMessages.add(key)
    seenMessagesOrder.push(key)
    return false
  }

  const receive = async (message: GatewayMessage) => {
    if (closed) return
    const ack = () => void deps.bridge.ack?.(message.bot, message.platform, message.chat, message.id)?.catch?.(() => {})
    if (isDuplicate(message)) return
    // A press answers a question; it never starts a turn.
    if (message.button) {
      ack()
      return press(message)
    }
    const key = sessionKey(message.bot, message.platform, message.chat)
    const which = chatCommand(message.text)
    if (which) {
      ack()
      return command(message, key, which)
    }
    // A list that numbers its choices is answered with the number, where the chat has no buttons or the person likes digits.
    const typed = /^\d{1,2}$/.test(message.text.trim()) ? Number(message.text.trim()) : undefined
    const listed =
      typed === undefined
        ? undefined
        : [...questions.values()].find(
            (question) =>
              question.numbered &&
              question.key === key &&
              (question.target.asker === undefined || question.target.asker === message.sender.id),
          )
    if (typed !== undefined && listed) {
      ack()
      const choice = listed.choices[typed - 1]
      if (choice) return listed.answer(choice.value)
      return void (await reply(message, t("gateway.pick.range", listed.choices.length)))
    }
    const state = stateOf(key)
    const counted = countMessage(state.times, now())
    state.times = counted.times
    /*
     * Said without waiting for the send: a message that came meanwhile would
     * otherwise be queued first, and answered first (G4 review, BASSO 1).
     */
    if (!counted.allowed) {
      ack()
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
    revoke: (bot, platform, sender) => {
      const theirs = (message: GatewayMessage) =>
        message.bot === bot && message.platform === platform && message.sender.id === sender
      for (const state of chats.values()) {
        for (let index = state.queue.length - 1; index >= 0; index--) {
          if (theirs(state.queue[index]!)) state.queue.splice(index, 1)
        }
        if (state.current && theirs(state.current)) {
          if (state.turn) state.turn.stop()
          else if (state.starting) state.cancelled = true
        }
      }
      for (const question of [...questions.values()]) {
        const target = question.target
        if (target.bot === bot && target.platform === platform && target.asker === sender) question.answer(undefined)
      }
    },
    busy: () => [...chats.entries()].filter(([, state]) => state.turn || state.starting).map(([key]) => key),
  }
}

const SECRET_ASSIGNMENT_PATTERN = /(?:key|token|secret|password|passwd|auth|bearer|credential|jwt|api[_-]?key)\s*[:=]/i

/**
 * An incomplete word/token at the end of partial streaming text might be a secret
 * mid-emission (e.g. `sk-proj...`, JWT, dotted password) that would escape redaction patterns.
 * We hold back the trailing incomplete word/token until terminated by whitespace.
 * In addition, if the trailing line contains an assignment (`=` or `:`) following a
 * secret-like name (e.g. `password=ab.`, `token: `), we hold back that entire line until
 * a newline terminates it, preventing partial leaks of secrets containing dots or short passwords.
 */
export function safePreviewText(text: string): string {
  if (!text) return ""

  // 1. Delimiter is only whitespace: hold back trailing incomplete word
  let candidate = text
  if (!/\s$/.test(candidate)) {
    const lastSpace = candidate.search(/\s\S*$/)
    if (lastSpace >= 0) {
      candidate = candidate.slice(0, lastSpace + 1)
    } else {
      return ""
    }
  }

  // 2. If the trailing line contains an assignment after a secret-like name, hold back the line
  const lastNewline = candidate.lastIndexOf("\n")
  const trailingLine = lastNewline >= 0 ? candidate.slice(lastNewline + 1) : candidate
  if (SECRET_ASSIGNMENT_PATTERN.test(trailingLine)) {
    return lastNewline >= 0 ? candidate.slice(0, lastNewline + 1) : ""
  }

  return candidate
}

/**
 * Recognizes structured flood errors from Rust (`Flood: ...`) as well as
 * generic HTTP 429 / flood messages.
 */
export function isFloodError(error: unknown): boolean {
  const errStr = error instanceof Error ? error.message : String(error)
  return /^Flood:/i.test(errStr) || /429|flood|too many/i.test(errStr)
}

