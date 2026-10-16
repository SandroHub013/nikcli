/**
 * A bot's money a day (the user's choice 5; review of the bots, S8).
 *
 * Routines and rooms had a cap in dollars (`routine.ts`, `room.ts`); a conversation with a bot, by hand in ADE or
 * from a phone, had none: with an API key, thirty messages an hour of up to thirty minutes each. Now:
 *
 * - the cap is asked only of a bot that spends money, the routines' «paid» (`routineModeOf`): a paid ragu model, or
 *   Claude Code with an API key. A subscription's figure is not a charge and a free model costs nothing: there no cap
 *   is asked and none holds. Codex with a key reports tokens and no dollars (`spendLine`), so its day cannot be
 *   counted, and the field says so;
 * - each conversation turn's cost is summed per bot and per local day, kept with the bot (by its file's path, as its
 *   account), from zero at midnight. Routines and rooms keep their own caps and are neither stopped nor counted here;
 * - at 80 % of the cap a notice, once a day, in the conversation in ADE and in the chat;
 * - at 100 % the bot does not start until tomorrow, or until the user raises the cap, and the answer says how. A turn
 *   already under way runs with what was left of the cap as its `maxCostUsd`, and is stopped past it, as a routine's.
 *
 * Two turns of the same bot at once (the panel and a chat, or two chats) each start with what is left: together they
 * can pass the cap by what one of them was allowed. The next turn is then refused.
 */

import { locale, t } from "../i18n"
import type { BotAccount } from "./account"
import type { AgentFile } from "./ragu"
import { appendMessage, applyProblem, emptyTalk, sendMessage } from "./talk"
import { dayOf, routineModeOf } from "./terms"
import type { Turn, TurnRequest, TurnResult } from "./turn"

/** What ADE keeps of a bot's money: the user's cap and the day's count. */
export interface BotSpend {
  /** Dollars a day for the bot's conversations. Absent: no cap set. */
  readonly capUsd?: number
  /** The local day `spentUsd` counts, `YYYY-MM-DD`. */
  readonly day?: string
  readonly spentUsd: number
  /** The day the 80 % notice was given: it is given once a day. */
  readonly warnedDay?: string
}

export const NO_SPEND: BotSpend = { spentUsd: 0 }

/** The highest cap the field takes: a guard against a slip of the keyboard, not a judgement on what to spend. */
export const SPEND_CAP_MAX_USD = 1000

/** The share of the cap past which the bot's owner is told. */
export const SPEND_NOTICE_SHARE = 0.8

/**
 * How a bot's turns are paid, for its cap: `money` is counted and capped; `none` (a subscription, a free model) is
 * neither; `unreported` is money the CLI does not say in dollars (Codex with a key).
 */
export type SpendTerms = "money" | "none" | "unreported"

export function spendTerms(
  runner: string | undefined,
  account: BotAccount | undefined,
  model: string | undefined,
  /** The catalog's word on a ragu model (`catalog.ts`); absent, the `:free` suffix. */
  free?: boolean,
): SpendTerms {
  const mode = routineModeOf(runner, account?.mode, model, free)
  if (mode !== "paid" && mode !== "key") return "none"
  return runner === "codex" ? "unreported" : "money"
}

/* ── reading what was saved ───────────────────────────────────────────── */

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

/** One bot's record, as far as it can be trusted: a broken field is dropped, a broken record is none. */
export function parseBotSpend(value: unknown): BotSpend {
  if (!value || typeof value !== "object" || Array.isArray(value)) return NO_SPEND
  const record = value as Record<string, unknown>
  const cap = record["capUsd"]
  const spent = record["spentUsd"]
  return {
    ...(finite(cap) && cap > 0 ? { capUsd: cap } : {}),
    ...(typeof record["day"] === "string" ? { day: record["day"] } : {}),
    spentUsd: finite(spent) && spent > 0 ? spent : 0,
    ...(typeof record["warnedDay"] === "string" ? { warnedDay: record["warnedDay"] } : {}),
  }
}

/** Every bot's record, by its file's path. */
export function parseSpendBook(raw: string | null | undefined): Record<string, BotSpend> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw ?? "{}")
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  return Object.fromEntries(Object.entries(parsed).map(([bot, value]) => [bot, parseBotSpend(value)]))
}

export interface SpendStore {
  get: (bot: string) => BotSpend
  set: (bot: string, spend: BotSpend) => void
}

/** Where the records live in the WebView's storage, one object with a key per bot (`forget.ts` takes a bot's away). */
export const SPEND_STORAGE_KEY = "ade.bots.spend"

/** In the WebView's storage, like the bots' accounts. */
export function localSpendStore(key: string = SPEND_STORAGE_KEY): SpendStore {
  /* The last write did not land (storage full or blocked): the count lives here until ADE closes. */
  let unsaved: Record<string, BotSpend> | undefined
  const read = (): Record<string, BotSpend> => {
    if (unsaved) return unsaved
    try {
      return parseSpendBook(localStorage.getItem(key))
    } catch {
      return {}
    }
  }
  return {
    get: (bot) => read()[bot] ?? NO_SPEND,
    set: (bot, spend) => {
      const next = { ...read(), [bot]: parseBotSpend(spend) }
      try {
        localStorage.setItem(key, JSON.stringify(next))
        unsaved = undefined
      } catch {
        unsaved = next
      }
    },
  }
}

export function memorySpendStore(): SpendStore {
  const saved = new Map<string, BotSpend>()
  return {
    get: (bot) => saved.get(bot) ?? NO_SPEND,
    set: (bot, spend) => void saved.set(bot, parseBotSpend(spend)),
  }
}

/* ── the day ──────────────────────────────────────────────────────────── */

/** The record as it stands on the local day of `now`: a new day counts from zero. */
export function spendOn(spend: BotSpend, now: number): BotSpend {
  const day = dayOf(now)
  return spend.day === day ? spend : { ...spend, day, spentUsd: 0 }
}

/** A turn's cost added to the day's. What is not a cost (negative, not a number) adds nothing. */
export function addSpend(spend: BotSpend, costUsd: number, now: number): BotSpend {
  const today = spendOn(spend, now)
  return { ...today, spentUsd: today.spentUsd + (finite(costUsd) && costUsd > 0 ? costUsd : 0) }
}

/** The record with the user's cap, or with none. */
export function withCap(spend: BotSpend, capUsd: number | undefined): BotSpend {
  const { capUsd: _old, ...rest } = spend
  return capUsd === undefined ? rest : { ...rest, capUsd }
}

export type SpendGate =
  | { readonly ok: true; readonly maxCostUsd?: number }
  | { readonly ok: false; readonly problem: string }

/**
 * Asked before a conversation turn of a bot that spends money: with a cap, the turn may spend what is left of it
 * today; with nothing left, it does not start, and `problem` says until when and how to raise the cap.
 */
export function spendGate(spend: BotSpend, now: number, name = ""): SpendGate {
  if (spend.capUsd === undefined) return { ok: true }
  const today = spendOn(spend, now)
  if (today.spentUsd >= spend.capUsd)
    return { ok: false, problem: t("bots.daily.reached", dollars(today.spentUsd), dollars(spend.capUsd), name) }
  return { ok: true, maxCostUsd: spend.capUsd - today.spentUsd }
}

/** What to tell the bot's owner after a turn: past 80 % of the cap, once a day; at the cap, that it stops. */
export function spendNotice(spend: BotSpend, now: number, name = ""): string | undefined {
  if (spend.capUsd === undefined || spend.warnedDay === dayOf(now)) return undefined
  const today = spendOn(spend, now)
  if (today.spentUsd < spend.capUsd * SPEND_NOTICE_SHARE) return undefined
  const key = today.spentUsd >= spend.capUsd ? "bots.daily.reached" : "bots.daily.notice"
  return t(key, dollars(today.spentUsd), dollars(spend.capUsd), name)
}

/** The notice of today was given. */
export function noticeGiven(spend: BotSpend, now: number): BotSpend {
  return { ...spend, warnedDay: dayOf(now) }
}

/* ── words ────────────────────────────────────────────────────────────── */

/** Dollars in the language's way: «0,42 $», «$0.42». */
export function dollars(value: number): string {
  return new Intl.NumberFormat(locale() === "it" ? "it-IT" : "en-US", {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

/** `/stato` from the phone: «Oggi 0,42 $ di 2,00 $.»; nothing for a bot that spends no money. */
export function spendStatus(spend: BotSpend, terms: SpendTerms, now: number): string | undefined {
  if (terms === "none") return undefined
  if (terms === "unreported") return t("bots.daily.unreported")
  const spent = dollars(spendOn(spend, now).spentUsd)
  return spend.capUsd === undefined
    ? t("bots.daily.statusNoCap", spent)
    : t("bots.daily.status", spent, dollars(spend.capUsd))
}

/** The line «Spesa di oggi» of the bot's Impostazioni; nothing for a bot that spends no money. */
export function spendTodayLine(spend: BotSpend, terms: SpendTerms, now: number): string | undefined {
  if (terms === "none") return undefined
  if (terms === "unreported") return t("bots.daily.unreported")
  const spent = spendOn(spend, now).spentUsd
  if (spend.capUsd === undefined) return t("bots.daily.todayNoCap", dollars(spent))
  const key = spent >= spend.capUsd ? "bots.daily.todayStopped" : "bots.daily.today"
  return t(key, dollars(spent), dollars(spend.capUsd))
}

export type CapInput =
  | { readonly ok: true; readonly capUsd?: number }
  | { readonly ok: false; readonly problem: string }

/** The cap as the user wrote it: dollars with a comma or a point and two decimals at most; empty is no cap. */
export function parseCap(text: string): CapInput {
  const written = text.trim()
  if (written.length === 0) return { ok: true }
  const value = /^\d+(?:[.,]\d{1,2})?$/.test(written) ? Number(written.replace(",", ".")) : Number.NaN
  if (!(value > 0) || value > SPEND_CAP_MAX_USD)
    return { ok: false, problem: t("bots.daily.capInvalid", dollars(SPEND_CAP_MAX_USD)) }
  return { ok: true, capUsd: value }
}

/** The cap as the field shows it: «2,5» in Italian, «2.5» in English. */
export function capText(capUsd: number | undefined): string {
  if (capUsd === undefined) return ""
  return locale() === "it" ? String(capUsd).replace(".", ",") : String(capUsd)
}

/* ── the turns ────────────────────────────────────────────────────────── */

/**
 * A turn that does not start because the cap is reached. In ADE it fails with the reason, as any turn that does not
 * run (`answer` false). For a chat the reason is the answer (`answer` true): the gateway sends a failure as a fixed
 * text, which would not say how to raise the cap.
 */
export function refusedTurn(message: string, problem: string, at: number, answer: boolean): Turn {
  const asked = sendMessage(emptyTalk(), message, at)
  const result: TurnResult = answer
    ? {
        status: "done",
        text: problem,
        tokens: 0,
        costUsd: 0,
        talk: { ...appendMessage(asked, { role: "error", text: problem }, at), status: "idle" },
      }
    : { status: "error", text: "", tokens: 0, costUsd: 0, problem, talk: applyProblem(asked, problem, at) }
  return { result: Promise.resolve(result), stop: () => {} }
}

export interface DailyCapDeps {
  readonly store: SpendStore
  /** The catalog's word on a ragu bot's model (`catalog.ts`); absent, the `:free` suffix. */
  readonly free?: (bot: AgentFile) => boolean | undefined
  readonly now?: () => number
}

/**
 * The turns from a chat with the bot's cap (`gateway/bridge.ts`): what is left of it as the turn's `maxCostUsd`, its
 * cost counted when it ends, the 80 % notice after the answer and in the thread ADE keeps of the chat. A turn that
 * failed leaves the notice to the next answer. Nothing changes for a bot that spends no money.
 */
export function withDailyCap(run: (request: TurnRequest) => Turn, deps: DailyCapDeps): (request: TurnRequest) => Turn {
  const now = deps.now ?? Date.now
  return (request) => {
    const bot = request.bot
    if (!bot) return run(request)
    if (spendTerms(request.runner, request.account, request.model ?? bot.model, deps.free?.(bot)) !== "money")
      return run(request)
    const gate = spendGate(deps.store.get(bot.path), now(), bot.identifier)
    if (!gate.ok) return refusedTurn(request.message, gate.problem, now(), true)
    const left = gate.maxCostUsd
    const turn = run(
      left === undefined ? request : { ...request, maxCostUsd: Math.min(request.maxCostUsd ?? left, left) },
    )
    const result = turn.result.then((done): TurnResult => {
      const at = now()
      const counted = addSpend(deps.store.get(bot.path), done.costUsd, at)
      const notice = done.status === "done" ? spendNotice(counted, at, bot.identifier) : undefined
      deps.store.set(bot.path, notice ? noticeGiven(counted, at) : counted)
      if (!notice) return done
      return {
        ...done,
        text: done.text.trim() ? `${done.text}\n\n${notice}` : notice,
        talk: appendMessage(done.talk, { role: "tool", tool: "ade", text: notice }, at),
      }
    })
    return { ...turn, result }
  }
}
