/**
 * A conversation with a bot, without a terminal.
 *
 * Talking to a bot used to mean opening its TUI in a pane. That is still
 * there — "Terminale" — but a conversation wants to be read as one: what you
 * said, what it said, what it did in between, and whether it is waiting on
 * you. This module is the thread: its messages, its question, what it cost.
 *
 * A bot's nikcli turn runs on ADE's nikcli server (B8d, `serve-turn.ts`),
 * where a question is an event with an id, answered by that id. Claude Code
 * and Codex print one JSON object per event, one process per turn; their
 * lines are folded in by `applyJsonLine` with each runner's own reading
 * (`runners.ts`).
 *
 * Pure, in a `.ts`: a JSON line misread is a message lost.
 */

import { t } from "../i18n"
import { stripAnsi } from "../session/stream"
import { limitNotice, limitReached, scrubSecrets } from "./terms"

export type TalkStatus = "idle" | "working" | "waiting" | "error"

export type TalkRole = "user" | "bot" | "tool" | "error"

export interface TalkMessage {
  readonly id: string
  readonly role: TalkRole
  /** The words. For a tool: its title, what nikcli would print beside the name. */
  readonly text: string
  /** The tool's name, for `tool` messages. */
  readonly tool?: string
  /** What the tool printed, when nikcli included it (bash does). */
  readonly output?: string
  /** A memory write this line reports, still undoable from here (`MemoryUndo`, B8a). */
  readonly memoryUndo?: string
  readonly at: number
}

export interface PendingPermission {
  /** nikcli's id for the question, on ADE's server (B8d): the answer goes to it, not to a menu. */
  readonly requestID?: string
  readonly permission: string
  readonly patterns: string
  readonly askedAt: number
  /** Why ADE asks (B8c): the kind of danger, in words. */
  readonly reason?: string
  /** What «Sempre» keeps for the bot: every kind of danger in the command, or the folder (`approval.ts`). */
  readonly always?: readonly string[]
  /** When the question becomes a Nega. */
  readonly expiresAt?: number
}

export interface Talk {
  /** nikcli's session id, once the first event has said it. */
  readonly sessionId?: string
  readonly messages: readonly TalkMessage[]
  readonly status: TalkStatus
  /** Summed over every step of the whole thread, for the card. */
  readonly tokens: number
  readonly costUsd: number
  /**
   * The turn that just finished: the model the CLI named, and only that
   * turn's tokens and cost. The thread totals above keep growing.
   */
  readonly lastTurn?: LastTurn
  /**
   * How the turn under way is paid for. Set when it starts, not stored:
   * a reload ends the turn. Usage lands in `byMode` under this name.
   */
  readonly turnMode?: TalkSpend | undefined
  /**
   * The turn started `metered` and a :free model made it free: a cost above
   * zero that arrives later puts it back. Not stored, like `turnMode`.
   */
  readonly turnFreedFrom?: TalkSpend | undefined
  /** Tokens and cost of the thread, split by how each turn was paid for. */
  readonly byMode?: Readonly<Partial<Record<TalkSpend, ModeTotal>>>
  /** Usage of the turn under way, until its result. Not stored. */
  readonly pendingTurn?: LastTurn
  /** When anything last happened, for the roster's clock. */
  readonly updatedAt?: number
  /** A question nikcli is waiting on. The thread shows it; `controller.ts` answers it, by its id (B8d). */
  readonly permission?: PendingPermission
  /**
   * A dangerous command Claude Code was refused (B8c): it cannot ask mid-turn,
   * so the thread offers «Sempre per questo bot», for the next turn.
   */
  readonly offer?: { readonly always: readonly string[]; readonly reason: string; readonly command: string }
  /**
   * The turn ended because the plan's limit was reached.
   *
   * The voice reads this, not the sentence: the sentence follows the
   * interface language, and a comparison with the Italian wording missed
   * an English one.
   */
  readonly limited?: boolean
  /** What went wrong starting or running the last turn, if anything. */
  readonly problem?: string
  /**
   * The start of a JSON event that has not ended yet.
   *
   * The process runs in a pty, and on Windows ConPTY re-renders what a
   * program writes at the terminal's width: an event longer than one row
   * arrives as several rows, each cut where the column ran out. The pieces
   * are kept here until they parse as one object again.
   */
  readonly partial?: string
  /**
   * The CLI has given its final event for the turn (Claude Code's `result`,
   * Codex's `turn.completed`). What follows is the process tidying up.
   */
  readonly ended?: boolean
  /**
   * The answer being written, before its message is complete: Claude Code's
   * text deltas, for a turn that asked for them. Gone once the whole message
   * arrives.
   */
  readonly streaming?: string
}

/** How that turn was paid for. A thread keeps one total per mode, so they are not added together. */
export type TalkSpend = "plan" | "api" | "free" | "metered"

export interface ModeTotal {
  readonly tokens: number
  readonly costUsd: number
}

export interface LastTurn {
  readonly model?: string
  readonly tokens: number
  readonly costUsd: number
  readonly mode?: TalkSpend
}

export function emptyTalk(): Talk {
  return { messages: [], status: "idle", tokens: 0, costUsd: 0 }
}

/**
 * A model id an event actually carried.
 *
 * A string `model`, `providerID` plus `modelID`, the same pair on `part`,
 * or the single key of Claude Code's `modelUsage`. Nothing here is the
 * model written in the bot's file.
 */
export function reportedModel(event: Record<string, unknown>): string | undefined {
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)
  const record = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  const pair = (source: Record<string, unknown> | undefined) => {
    if (!source) return undefined
    const provider = text(source["providerID"])
    const id = text(source["modelID"])
    if (provider && id) return `${provider}/${id}`
    return id
  }
  const direct = text(event["model"]) ?? pair(event)
  if (direct) return direct
  const part = record(event["part"])
  const fromPart = text(part?.["model"]) ?? pair(record(part?.["model"])) ?? pair(part)
  if (fromPart) return fromPart
  const message = record(event["message"])
  const fromMessage = text(message?.["model"])
  if (fromMessage) return fromMessage
  const usage = record(event["modelUsage"])
  const names = usage ? Object.keys(usage).filter((name) => name.trim().length > 0) : []
  return names.length === 1 ? names[0] : undefined
}

function rememberModel(talk: Talk, model: string | undefined): Talk {
  const named = model?.trim()
  if (!named) return talk
  const pending = talk.pendingTurn ?? { tokens: 0, costUsd: 0 }
  const remembered = { ...talk, pendingTurn: { ...pending, model: named } }
  /*
   * A bot on nikcli's default model starts its turn `metered`: the default
   * can be paid. Once the turn names a free model, it was free, and what it
   * already counted goes with it (Verifiche, live 3: «Predefinito» turns on
   * a :free model summed as «a consumo»). The test is `isFreeModel`'s, in
   * runners.ts, which imports this file.
   */
  // Only while nothing was paid: a cost above zero is a router's fallback on a paid model, and stays «a consumo».
  if (talk.turnMode === "metered" && pending.costUsd === 0 && /:free$/i.test(named)) {
    return { ...spentAs(remembered, "free"), turnFreedFrom: "metered" }
  }
  return remembered
}

/** The turn under way paid for as `mode`, with what it already counted moved over. */
function spentAs(talk: Talk, mode: TalkSpend): Talk {
  const from = talk.turnMode
  const pending = talk.pendingTurn
  let byMode = talk.byMode
  const counted = from && pending && byMode?.[from] && (pending.tokens !== 0 || pending.costUsd !== 0)
  if (from && pending && counted) {
    const left = { tokens: byMode![from]!.tokens - pending.tokens, costUsd: byMode![from]!.costUsd - pending.costUsd }
    const rest = { ...byMode }
    delete rest[from]
    byMode = addMode(left.tokens > 0 || left.costUsd > 0 ? { ...rest, [from]: left } : rest, mode, pending.tokens, pending.costUsd)
  }
  return { ...talk, turnMode: mode, ...(byMode ? { byMode } : {}) }
}

/** Keeps the model an event named, for the turn under way. */
export function noteReportedModel(talk: Talk, event: Record<string, unknown>): Talk {
  return rememberModel(talk, reportedModel(event))
}

const TALK_SPENDS: readonly TalkSpend[] = ["plan", "api", "free", "metered"]

function isTalkSpend(value: unknown): value is TalkSpend {
  return typeof value === "string" && (TALK_SPENDS as readonly string[]).includes(value)
}

function addMode(byMode: Talk["byMode"], mode: TalkSpend, tokens: number, costUsd: number): NonNullable<Talk["byMode"]> {
  const prev = byMode?.[mode] ?? { tokens: 0, costUsd: 0 }
  return { ...byMode, [mode]: { tokens: prev.tokens + tokens, costUsd: prev.costUsd + costUsd } }
}

/** Adds this event's usage to the turn under way, and keeps it when the turn ends. */
export function noteTurnUsage(talk: Talk, tokens: number, costUsd: number, close: boolean): Talk {
  // Made free by its model's name, and then it cost something: it was paid after all.
  if (costUsd > 0 && talk.turnMode === "free" && talk.turnFreedFrom) {
    talk = { ...spentAs(talk, talk.turnFreedFrom), turnFreedFrom: undefined }
  }
  const pending = talk.pendingTurn ?? { tokens: 0, costUsd: 0 }
  const next = { ...pending, tokens: pending.tokens + tokens, costUsd: pending.costUsd + costUsd }
  const byMode = talk.turnMode ? addMode(talk.byMode, talk.turnMode, tokens, costUsd) : talk.byMode
  if (!close) return { ...talk, pendingTurn: next, ...(byMode ? { byMode } : {}) }
  return {
    ...talk,
    pendingTurn: undefined,
    ...(byMode ? { byMode } : {}),
    lastTurn: {
      ...(next.model ? { model: next.model } : {}),
      tokens: next.tokens,
      costUsd: next.costUsd,
      ...(talk.turnMode ? { mode: talk.turnMode } : {}),
    },
  }
}

/** A turn that ended without a result still keeps whatever usage it had gathered. */
export function sealTurn(talk: Talk): Talk {
  const pending = talk.pendingTurn
  if (!pending || (pending.tokens === 0 && pending.costUsd === 0 && !pending.model)) {
    return pending ? { ...talk, pendingTurn: undefined } : talk
  }
  return noteTurnUsage(talk, 0, 0, true)
}

let sequence = 0
function nextId(prefix: string, at: number): string {
  return `${prefix}-${at}-${++sequence}`
}

/** What the user just typed, put on the thread and the turn marked as started. */
export function sendMessage(talk: Talk, text: string, at: number): Talk {
  return {
    ...talk,
    messages: [...talk.messages, { id: nextId("u", at), role: "user", text, at }],
    status: "working",
    updatedAt: at,
    problem: undefined,
    permission: undefined,
    ended: undefined,
    // One limit must not mark every later turn, including one reloaded from disk.
    limited: undefined,
    turnMode: undefined,
    turnFreedFrom: undefined,
    pendingTurn: { tokens: 0, costUsd: 0 },
  }
}

/* ── the JSON events ────────────────────────────────────────────────────── */

/** How much of a broken event is kept before giving up on it. */
const MAX_PARTIAL = 256 * 1024

/** nikcli's token record is `{input, output, reasoning, cache: {read, write}}`; the sum is what a bill counts. */
function sumTokens(tokens: unknown): number {
  if (!tokens || typeof tokens !== "object") return 0
  let total = 0
  for (const value of Object.values(tokens as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) total += value
    else if (value && typeof value === "object") total += sumTokens(value)
  }
  return total
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; data?: { message?: unknown }; name?: unknown }
    if (typeof record.message === "string") return record.message
    if (record.data && typeof record.data.message === "string") return record.data.message
    if (typeof record.name === "string") return record.name
  }
  return "Errore sconosciuto."
}

/**
 * One line of a process that prints one JSON object per line, folded in by
 * `onEvent`. Shared by every runner: the reassembly of an event ConPTY cut
 * into rows is the same whoever wrote it. `onOther` sees the lines that are
 * not JSON.
 */
export function applyJsonLine(
  talk: Talk,
  line: string,
  at: number,
  onEvent: (talk: Talk, event: Record<string, unknown>, at: number) => Talk,
  onOther: (talk: Talk, line: string, at: number) => Talk = (current) => current,
): Talk {
  const clean = stripAnsi(line)

  /*
   * A piece of an event, or the rest of one.
   *
   * A row that opens an object but does not close it is the first piece; the
   * rows after it are glued on until the whole parses. Anything else while
   * pieces are pending is glued on too — a JSON string can contain any text —
   * up to a limit, past which the pieces were never going to be one event.
   */
  if (talk.partial !== undefined) {
    const joined = talk.partial + clean
    const event = parseObject(joined)
    if (event) return onEvent({ ...talk, partial: undefined }, event, at)
    if (joined.length > MAX_PARTIAL) return { ...talk, partial: undefined }
    return { ...talk, partial: joined }
  }
  const opening = clean.trimStart()
  if (opening.startsWith("{") && !parseObject(clean)) {
    return { ...talk, partial: clean }
  }

  const event = parseObject(clean)
  if (!event) return onOther(talk, line, at)
  return onEvent(talk, event, at)
}

function parseObject(line: string): Record<string, unknown> | undefined {
  const trimmed = stripAnsi(line).trim()
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * How much of a tool's printout is kept.
 *
 * The rest is what filled localStorage until a reload lost the thread (review
 * M3). A key in the kept part is replaced; a key past the cut is dropped.
 */
export const TOOL_OUTPUT_MAX = 16 * 1024

const truncatedMark = () => `\n${t("bots.talk.truncated")}`

/** A tool printout safe to show and to store: keys out, then the size cap. */
export function limitToolOutput(text: string): string {
  const clean = scrubSecrets(text)
  const mark = truncatedMark()
  if (clean.length <= TOOL_OUTPUT_MAX) return clean
  return clean.slice(0, TOOL_OUTPUT_MAX - mark.length) + mark
}

function forStorage<T extends { readonly role: TalkRole; readonly text: string; readonly output?: string }>(message: T): T {
  if (message.role === "tool") {
    return {
      ...message,
      text: scrubSecrets(message.text),
      ...(message.output !== undefined ? { output: limitToolOutput(message.output) } : {}),
    }
  }
  if (message.role === "error" || message.role === "bot") return { ...message, text: scrubSecrets(message.text) }
  return message
}

/** A message put on the thread, with an id of its kind. Used by the runners' adapters. */
export function appendMessage(
  talk: Talk,
  message: {
    readonly role: TalkRole
    readonly text: string
    readonly tool?: string
    readonly output?: string
    readonly id?: string
    readonly memoryUndo?: string
  },
  at: number,
): Talk {
  const prefix = message.role === "user" ? "u" : message.role === "bot" ? "b" : message.role === "tool" ? "t" : "e"
  const { id, ...rest } = forStorage(message)
  return {
    ...talk,
    messages: [...talk.messages, { ...rest, id: id ?? nextId(prefix, at), at }],
    updatedAt: at,
  }
}

/**
 * A message put on the thread, or put in place of the one with its id: nikcli's
 * server sends a part whole each time it changes (B8d), a text as it grows and
 * a tool from running to done. Stored as `appendMessage` stores it; the first
 * time it came stays its time.
 */
export function upsertMessage(
  talk: Talk,
  message: { readonly id: string; readonly role: TalkRole; readonly text: string; readonly tool?: string; readonly output?: string },
  at: number,
): Talk {
  const index = talk.messages.findIndex((existing) => existing.id === message.id)
  if (index < 0) return appendMessage(talk, message, at)
  const messages = talk.messages.slice()
  messages[index] = { ...forStorage(message), at: messages[index]!.at }
  return { ...talk, messages, updatedAt: at }
}

/** Adds what a tool printed to the tool message with that id, when it is on the thread. */
export function attachOutput(talk: Talk, id: string, output: string): Talk {
  if (output.trim().length === 0) return talk
  const index = talk.messages.findIndex((message) => message.id === id)
  if (index < 0) return talk
  const messages = talk.messages.slice()
  messages[index] = { ...messages[index]!, output: limitToolOutput(output) }
  return { ...talk, messages }
}

export { sumTokens, errorText }

export type PermissionAnswer = "once" | "always" | "reject"

/** After the answer is sent: the question is gone, the turn goes on. */
export function permissionAnswered(talk: Talk, at: number): Talk {
  return { ...talk, permission: undefined, status: "working", updatedAt: at }
}

/**
 * The process is gone. A clean exit ends the turn; anything else, with no
 * error already on the thread, is said once so the silence has a reason.
 */
export function applyExit(talk: Talk, code: number | null, at: number, program = "nikcli", lastWords?: string): Talk {
  talk = sealTurn(talk)
  const limited = withLimitNotice(talk, code, at, program)
  if (limited) return limited
  if (code === 0 || code === null) {
    return { ...talk, status: talk.status === "error" ? "error" : "idle", permission: undefined, updatedAt: at }
  }
  const alreadySaid = talk.messages.at(-1)?.role === "error"
  return {
    ...talk,
    status: "error",
    permission: undefined,
    updatedAt: at,
    messages: alreadySaid
      ? talk.messages
      : [
          ...talk.messages,
          {
            id: nextId("e", at),
            role: "error",
            // The CLI's last plain line — its error on stderr, which shares the stream — says why.
            text: lastWords
              ? t("bots.talk.exitedBecause", program, code ?? 0, scrubSecrets(lastWords))
              : t("bots.talk.exited", program, code ?? 0),
            at,
          },
        ],
  }
}

/**
 * A turn that ended on the plan's limit says so, and that nothing will retry it.
 *
 * Looked for in what the CLI said since the user's last message, so an old
 * limit already answered does not come back.
 */
function withLimitNotice(talk: Talk, code: number | null, at: number, program: string): Talk | undefined {
  if (talk.status !== "error" && (code === 0 || code === null)) return undefined
  const lastUser = talk.messages.findLastIndex((message) => message.role === "user")
  const said = talk.messages.slice(lastUser + 1)
  if (!said.some((message) => limitReached(message.text)) && !limitReached(talk.problem ?? "")) return undefined
  const notice = limitNotice(program)
  return {
    ...talk,
    limited: true,
    status: "error",
    permission: undefined,
    updatedAt: at,
    messages: said.some((message) => message.text === notice)
      ? talk.messages
      : [...talk.messages, { id: nextId("e", at), role: "error", text: notice, at }],
  }
}

/** Something went wrong before the process even spoke. */
export function applyProblem(talk: Talk, problem: string, at: number): Talk {
  return { ...talk, status: "error", problem, updatedAt: at }
}

/* ── what the roster shows ──────────────────────────────────────────────── */

/**
 * The line under the bot's name: the last thing said or done, by whoever.
 *
 * A tool call reads as what it did — "bash: bun test" — because a bot whose
 * last act was running the tests is better described by that than by the
 * sentence it wrote before. An error is shown as such. Nothing yet is the
 * bot's own description, which is what a contact with no history has.
 */
export function lastLine(talk: Talk, fallback: string): string {
  if (talk.status === "waiting" && talk.permission) return t("bots.lastLine.permission", talk.permission.permission)
  const last = talk.messages.at(-1)
  if (!last) return fallback
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()
  switch (last.role) {
    case "user":
      return t("bots.lastLine.you", oneLine(last.text))
    case "tool":
      return `${last.tool}: ${oneLine(last.text)}`
    case "error":
      return oneLine(last.text)
    default:
      return oneLine(last.text)
  }
}

/**
 * When, as a contact list says it: the time today, "ieri", the weekday within
 * the week, the date beyond it. Under a minute is "ora", because the roster
 * is where a bot that just answered should look alive.
 */
export function formatWhen(at: number | undefined, now: number): string {
  if (at === undefined) return ""
  const diff = now - at
  if (diff < 60_000 && diff > -60_000) return t("bots.when.now")
  const date = new Date(at)
  const today = new Date(now)
  const sameDay = date.toDateString() === today.toDateString()
  if (sameDay) return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  const yesterday = new Date(now - 86_400_000)
  if (date.toDateString() === yesterday.toDateString()) return t("bots.when.yesterday")
  if (diff < 6 * 86_400_000 && diff > 0) return t("bots.when.weekday", date.getDay())
  return `${date.getDate()} ${t("bots.when.month", date.getMonth())}`
}

/**
 * Which bot a message is for, when it names one.
 *
 * `@tester confermi?` is for tester. The name must be a whole word right
 * after the `@`, and must be a bot that exists; `@` inside an email or a
 * decorator is left alone. Returns the identifier and the text without it.
 */
export function mentionIn(
  text: string,
  identifiers: readonly string[],
): { readonly identifier: string; readonly rest: string } | undefined {
  const match = /(^|\s)@([\w.-]+)/.exec(text)
  if (!match) return undefined
  const named = match[2] ?? ""
  const identifier = identifiers.find((candidate) => candidate.toLowerCase() === named.toLowerCase())
  if (!identifier) return undefined
  const rest = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).replace(/\s+/g, " ").trim()
  return { identifier, rest }
}

/* ── surviving a reload ─────────────────────────────────────────────────── */

const SAVED_MESSAGES = 200

/**
 * The whole archive, in characters of JSON.
 *
 * One key, not the whole of localStorage, and still small enough that the
 * write fits the WebView quota. Older messages go first when it does not.
 */
export const TALK_ARCHIVE_MAX = 256 * 1024

/** The thread as text for storage. Trimmed, and never mid-turn: a reload ends whatever was running. */
export function serializeTalk(talk: Talk): string {
  let messages = talk.messages.slice(-SAVED_MESSAGES).map((message) => forStorage(message))
  const pack = (list: readonly TalkMessage[]) =>
    JSON.stringify({
      sessionId: talk.sessionId,
      messages: list,
      tokens: talk.tokens,
      costUsd: talk.costUsd,
      ...(talk.lastTurn ? { lastTurn: talk.lastTurn } : {}),
      ...(talk.byMode ? { byMode: talk.byMode } : {}),
      updatedAt: talk.updatedAt,
    })
  let encoded = pack(messages)
  while (encoded.length > TALK_ARCHIVE_MAX && messages.length > 1) {
    messages = messages.slice(1)
    encoded = pack(messages)
  }
  return encoded
}

function parseLastTurn(value: unknown): LastTurn | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as { model?: unknown; tokens?: unknown; costUsd?: unknown }
  const tokens = typeof record.tokens === "number" ? record.tokens : 0
  const costUsd = typeof record.costUsd === "number" ? record.costUsd : 0
  const model = typeof record.model === "string" && record.model.trim() ? record.model : undefined
  const mode = isTalkSpend((record as { mode?: unknown }).mode) ? (record as { mode: TalkSpend }).mode : undefined
  if (!model && tokens === 0 && costUsd === 0 && !mode) return undefined
  return { ...(model ? { model } : {}), tokens, costUsd, ...(mode ? { mode } : {}) }
}

function parseByMode(value: unknown): Talk["byMode"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const out: Partial<Record<TalkSpend, ModeTotal>> = {}
  for (const mode of TALK_SPENDS) {
    const row = (value as Record<string, unknown>)[mode]
    if (!row || typeof row !== "object" || Array.isArray(row)) continue
    const tokens = (row as { tokens?: unknown }).tokens
    const costUsd = (row as { costUsd?: unknown }).costUsd
    if (typeof tokens !== "number" || typeof costUsd !== "number") continue
    out[mode] = { tokens, costUsd }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** The stored thread, tolerating anything: an unreadable one is an empty one. */
export function parseTalk(raw: string | null | undefined): Talk {
  if (!raw) return emptyTalk()
  try {
    const parsed = JSON.parse(raw) as Partial<Talk> & { messages?: unknown }
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages.filter(
          (m): m is TalkMessage =>
            !!m &&
            typeof m === "object" &&
            typeof (m as TalkMessage).id === "string" &&
            typeof (m as TalkMessage).text === "string" &&
            typeof (m as TalkMessage).at === "number" &&
            ["user", "bot", "tool", "error"].includes((m as TalkMessage).role),
        )
      : []
    return {
      ...emptyTalk(),
      ...(typeof parsed.sessionId === "string" ? { sessionId: parsed.sessionId } : {}),
      messages,
      tokens: typeof parsed.tokens === "number" ? parsed.tokens : 0,
      costUsd: typeof parsed.costUsd === "number" ? parsed.costUsd : 0,
      ...(() => {
        const last = parseLastTurn(parsed.lastTurn)
        return last ? { lastTurn: last } : {}
      })(),
      ...(() => {
        const byMode = parseByMode((parsed as { byMode?: unknown }).byMode)
        return byMode ? { byMode } : {}
      })(),
      ...(typeof parsed.updatedAt === "number" ? { updatedAt: parsed.updatedAt } : {}),
    }
  } catch {
    return emptyTalk()
  }
}

/** Prefix of every stored thread. A newline after it means the project is part of the key. */
export const TALK_KEY_PREFIX = "ade.bots.talk:"

/**
 * Where a bot's thread is kept.
 *
 * The path, because the identifier repeats across scopes, and the open
 * project: a global bot's file is the same path in every project, and its
 * session id must not follow it into the next one.
 */
export function talkKey(path: string, project = ""): string {
  return `${TALK_KEY_PREFIX}${project}\n${path}`
}

/** A thread saved before the project was part of the key: `ade.bots.talk:<path>`, with no newline. */
export function isLegacyTalkKey(key: string): boolean {
  return key.startsWith(TALK_KEY_PREFIX) && !key.slice(TALK_KEY_PREFIX.length).includes("\n")
}
