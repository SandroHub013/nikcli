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
 *   ragu's question, an event with its id on ADE's server (B8d), goes to
 *   the phone (`approval.ts`).
 *
 * Nothing is read from a chat before this listens: `gateway_ready` is called
 * once the listener is in place, and Rust holds every gateway until then.
 */

import { t } from "../../i18n"
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
import { chatCommand, countMessage, CHAT_MESSAGES_PER_HOUR, framedMessage, mayRun } from "./policy"
import type { BotAccount } from "../account"
import { offersRemoteCommands, REMOTE_OFF, remoteTools, type RemoteSetting } from "./remote"
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
  /** The bot's money today for `/stato` (`spend.ts`): «Oggi 0,42 $ di 2,00 $.»; absent or undefined, not said. */
  readonly spendToday?: (bot: string) => Promise<string | undefined>
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
  /**
   * How many times `/nuova` was said. A turn that was running when it came
   * must not write its session and thread back at its end: the next message
   * went on with the conversation the user had just dropped (review area 2).
   */
  fresh: number
}

const TYPING_EVERY_MS = 4_000

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
      questions.set(id, { key: sessionKey(target.bot, target.platform, target.chat), target, choices, answer })
      const buttons = choices.map((choice, index) => ({ label: choice.label, data: `${id}:${index}` }))
      deps.bridge.sendButtons(target.bot, target.platform, target.chat, question, buttons).catch((error) => {
        warn(
          `ADE: domanda del gateway non mandata (${target.platform}): ${error instanceof Error ? error.message : String(error)}`,
        )
        answer(undefined)
      })
    })

  const stateOf = (key: string): ChatState => {
    let state = chats.get(key)
    if (!state) {
      state = { queue: [], starting: false, cancelled: false, times: [], limited: false, fresh: 0 }
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

  const command = async (message: GatewayMessage, key: string, which: string) => {
    const state = stateOf(key)
    const running = state.turn !== undefined || state.starting
    if (which === "new") {
      state.fresh += 1
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
    if (which === "status") {
      const said = running ? t("gateway.status.working", state.queue.length) : t("gateway.status.idle")
      const spent = await deps.spendToday?.(message.bot).catch(() => undefined)
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
    void deps.bridge.ack?.(message.bot, message.platform, message.chat, message.id)?.catch?.(() => {})
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
      const bot = loaded.bot
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
      if (kept && result.sessionId) deps.sessions.set(key, { project, runner, sessionId: result.sessionId })
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

