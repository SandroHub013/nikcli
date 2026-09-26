/**
 * A bot's routines (B11): a prompt the bot runs on its own, every few hours
 * or every day at a time, only on the runners `terms.ts` allows (D88).
 *
 * Everything here is data and pure functions over it: what a routine is,
 * when it is due, and whether it may run now. `createRoutineScheduler` ties
 * them to a clock and to the bot's turns; the panel draws the same data.
 *
 * The rules, from «B11 in dettaglio»:
 * - each routine has its own consent, a SHA-256 of prompt, runner, mode,
 *   model, cap and the key's name (`routineConsentHash`); a change in any of
 *   them suspends it until the user agrees again;
 * - before every run the list is asked again (`routinePolicy`) and the caps
 *   are checked: runs a day and money a day for the runner and mode as a
 *   whole, the gap between two runs of the same routine, money per run;
 * - a plan's limit stops that runner and mode for the day, with no retry;
 * - routines run only while ADE is open, one at a time; a run missed while
 *   it was closed is made up once at most, and the routine says so.
 */

import { isAdeTestBuild } from "../chat/model"
import { t } from "../i18n"
import type { BotAccount } from "./account"
import {
  routineConsentHash,
  routineModeOf,
  routinePolicy,
  ROUTINE_POLICY,
  type RoutineCap,
  type RoutineMode,
} from "./terms"
import { applyProblem, emptyTalk } from "./talk"
import { runTurn, type Turn, type TurnDeps, type TurnRequest, type TurnResult } from "./turn"

/** What the scheduler cleared one run for. */
export interface RoutineRun {
  /** Dollars the run may spend; past them it is stopped (`TurnRequest.maxCostUsd`). Absent on a plan, 0 on a free model. */
  readonly maxCostUsd?: number
  /** The catalog's word on the model (`catalog.ts`). */
  readonly free?: boolean
}

/**
 * The gate one execution passes at spawn: a runner and mode off the list
 * never start, whatever the scheduler thought a moment before.
 */
export function runRoutine(request: TurnRequest, run: RoutineRun = {}, deps: TurnDeps = {}): Turn {
  const model = request.model ?? request.bot?.model
  const offer = routineOffer(request.runner, request.account, model, run.free !== undefined ? { free: run.free } : {})
  if (!offer.allowed) {
    const reason = offer.reason ?? t("bots.routine.problem.notAllowed")
    const talk = applyProblem(emptyTalk(), reason, Date.now())
    return {
      result: Promise.resolve({
        status: "error",
        text: "",
        tokens: 0,
        costUsd: 0,
        problem: reason,
        talk,
      }),
      stop: () => {},
    }
  }
  return runTurn(request, deps)
}

/* ── what a routine is ─────────────────────────────────────────────────── */

export type RoutineEvery =
  | { readonly kind: "hours"; readonly hours: number }
  /** Every day at `at`, local time, `HH:MM`. */
  | { readonly kind: "daily"; readonly at: string }

/** What the user allows a routine to spend, in dollars; within the row's cap. */
export interface RoutineSpend {
  readonly perRunUsd: number
  readonly perDayUsd: number
}

export interface Routine {
  readonly id: string
  /** The bot file's path. */
  readonly bot: string
  readonly prompt: string
  readonly every: RoutineEvery
  /** The folder the bot runs in: the project open when the routine was made. */
  readonly cwd?: string
  readonly spend?: RoutineSpend
  /** `routineConsentHash` as it was when the user agreed. */
  readonly consent: string
  readonly createdAt: number
  /** The user's own switch. */
  readonly paused?: boolean
}

/** One routine's record: what it did today, and why it does not run. */
export interface RoutineLog {
  readonly lastRunAt?: number
  /** The local day `runs` and `spentUsd` count, `YYYY-MM-DD`. */
  readonly day?: string
  readonly runs: number
  readonly spentUsd: number
  /** Set: the routine does not run until the user acts (consent, list, spend). */
  readonly suspended?: string
  /** The last thing worth saying, with when. */
  readonly note?: string
  readonly noteAt?: number
}

/** A runner and mode as a whole (`claude:plan`): the day's runs, money and limit. */
export interface PlanLog {
  readonly day: string
  readonly runs: number
  readonly spentUsd: number
  /** The plan's limit was reached: nothing more today, no retry. */
  readonly stopped?: boolean
}

export interface RoutineBook {
  readonly routines: readonly Routine[]
  readonly logs: Readonly<Record<string, RoutineLog>>
  readonly plans: Readonly<Record<string, PlanLog>>
}

export const EMPTY_BOOK: RoutineBook = { routines: [], logs: {}, plans: {} }

const EMPTY_LOG: RoutineLog = { runs: 0, spentUsd: 0 }

/** The hours a routine may be set to: from one to a week. */
export const ROUTINE_HOURS = { min: 1, max: 168 } as const

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

/* ── reading what was saved ───────────────────────────────────────────── */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

function parseEvery(value: unknown): RoutineEvery | undefined {
  if (!isRecord(value)) return undefined
  if (value["kind"] === "hours" && finite(value["hours"]) && Number.isInteger(value["hours"])) {
    const hours = value["hours"]
    if (hours >= ROUTINE_HOURS.min && hours <= ROUTINE_HOURS.max) return { kind: "hours", hours }
  }
  if (value["kind"] === "daily" && typeof value["at"] === "string" && TIME.test(value["at"])) {
    return { kind: "daily", at: value["at"] }
  }
  return undefined
}

function parseSpend(value: unknown): RoutineSpend | undefined {
  if (!isRecord(value)) return undefined
  const perRun = value["perRunUsd"]
  const perDay = value["perDayUsd"]
  if (!finite(perRun) || !finite(perDay) || perRun <= 0 || perDay <= 0) return undefined
  return { perRunUsd: perRun, perDayUsd: perDay }
}

function parseRoutine(value: unknown): Routine | undefined {
  if (!isRecord(value)) return undefined
  const { id, bot, prompt, consent, createdAt, cwd, paused } = value
  const every = parseEvery(value["every"])
  if (typeof id !== "string" || id.length === 0) return undefined
  if (typeof bot !== "string" || bot.length === 0) return undefined
  if (typeof prompt !== "string" || prompt.trim().length === 0) return undefined
  if (typeof consent !== "string" || !finite(createdAt) || !every) return undefined
  const spend = parseSpend(value["spend"])
  return {
    id,
    bot,
    prompt,
    every,
    consent,
    createdAt,
    ...(typeof cwd === "string" && cwd.length > 0 ? { cwd } : {}),
    ...(spend ? { spend } : {}),
    ...(paused === true ? { paused: true } : {}),
  }
}

function parseLog(value: unknown): RoutineLog {
  if (!isRecord(value)) return EMPTY_LOG
  return {
    runs: finite(value["runs"]) ? value["runs"] : 0,
    spentUsd: finite(value["spentUsd"]) ? value["spentUsd"] : 0,
    ...(finite(value["lastRunAt"]) ? { lastRunAt: value["lastRunAt"] } : {}),
    ...(typeof value["day"] === "string" ? { day: value["day"] } : {}),
    ...(typeof value["suspended"] === "string" ? { suspended: value["suspended"] } : {}),
    ...(typeof value["note"] === "string" ? { note: value["note"] } : {}),
    ...(finite(value["noteAt"]) ? { noteAt: value["noteAt"] } : {}),
  }
}

function parsePlan(value: unknown): PlanLog | undefined {
  if (!isRecord(value) || typeof value["day"] !== "string") return undefined
  return {
    day: value["day"],
    runs: finite(value["runs"]) ? value["runs"] : 0,
    spentUsd: finite(value["spentUsd"]) ? value["spentUsd"] : 0,
    ...(value["stopped"] === true ? { stopped: true } : {}),
  }
}

/** What was saved, as far as it can be trusted: a broken routine is dropped, never half-read. */
export function parseBook(raw: string | null | undefined): RoutineBook {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw ?? "null")
  } catch {
    return EMPTY_BOOK
  }
  if (!isRecord(parsed)) return EMPTY_BOOK
  const routines = Array.isArray(parsed["routines"])
    ? parsed["routines"].map(parseRoutine).filter((routine): routine is Routine => routine !== undefined)
    : []
  const logs: Record<string, RoutineLog> = {}
  const savedLogs = isRecord(parsed["logs"]) ? parsed["logs"] : {}
  for (const routine of routines)
    if (savedLogs[routine.id] !== undefined) logs[routine.id] = parseLog(savedLogs[routine.id])
  const plans: Record<string, PlanLog> = {}
  if (isRecord(parsed["plans"])) {
    for (const [key, value] of Object.entries(parsed["plans"])) {
      const plan = parsePlan(value)
      if (plan) plans[key] = plan
    }
  }
  return { routines, logs, plans }
}

export interface RoutineStore {
  get: () => RoutineBook
  set: (book: RoutineBook) => void
}

const STORAGE_KEY = "ade.bots.routines"

/** In the WebView's storage, like the bots' accounts. No credential is ever part of it. */
export function localRoutineStore(key: string = STORAGE_KEY): RoutineStore {
  let memory: RoutineBook | undefined
  return {
    get: () => {
      try {
        return parseBook(localStorage.getItem(key))
      } catch {
        return memory ?? EMPTY_BOOK
      }
    },
    set: (book) => {
      memory = book
      try {
        localStorage.setItem(key, JSON.stringify(book))
      } catch {
        // Storage blocked: the routines last until ADE closes.
      }
    },
  }
}

export function memoryRoutineStore(start: RoutineBook = EMPTY_BOOK): RoutineStore {
  let book = start
  return { get: () => book, set: (next) => void (book = next) }
}

/* ── the list, for a bot ──────────────────────────────────────────────── */

/** Where the row a runner and mode fall under says it comes from. */
export interface RoutineOffer {
  readonly mode: RoutineMode
  readonly allowed: boolean
  readonly cap?: RoutineCap
  readonly reason?: string
  readonly source?: string
  readonly checked?: string
}

/** What else decides a bot's offer. */
export interface RoutineOfferOptions {
  /** The catalog's word on a nikcli model (`catalog.ts`); absent, the `:free` suffix. */
  readonly free?: boolean | undefined
  /** ADE Test runs only what costs nothing: free models and subscriptions. Default: `isAdeTestBuild()`. */
  readonly testBuild?: boolean
}

/**
 * Whether a bot may have routines, and under which cap. The panel shows the
 * Routine section only when `allowed`; otherwise the reason and the source,
 * with no disabled button inviting a way round.
 */
export function routineOffer(
  runner: string,
  account: BotAccount | undefined,
  model: string | undefined,
  options: RoutineOfferOptions = {},
): RoutineOffer {
  const mode = routineModeOf(runner, account?.mode, model, options.free)
  const policy = routinePolicy(runner, mode, model, options.free)
  const row = ROUTINE_POLICY.find((entry) => entry.runner === runner && entry.mode === mode)
  const where = {
    ...(row?.source ? { source: row.source } : {}),
    ...(row?.checked ? { checked: row.checked } : {}),
  }
  if (!policy.allowed) return { mode, allowed: false, reason: policy.reason, ...where }
  // ADE Test never spends the user's money (review, M2): a paid model or a key is off there.
  if ((options.testBuild ?? isAdeTestBuild()) && mode !== "free" && mode !== "plan")
    return { mode, allowed: false, reason: t("bots.routine.testOnlyFree"), ...where }
  return { mode, allowed: true, cap: policy.cap, ...where }
}

/** The offer for a bot as it is now. */
export const offerFor = (context: RoutineContext) =>
  routineOffer(context.runner, context.account, context.model, { free: context.free })

/** The key the runner and mode's day is counted under. */
export const planKey = (runner: string, mode: RoutineMode) => `${runner}:${mode}`

/** What a consent covers, besides the routine itself. */
export interface RoutineContext {
  readonly runner: string
  readonly model?: string | undefined
  readonly account?: BotAccount | undefined
  /** The catalog's word on a nikcli model (`catalog.ts`); absent, the `:free` suffix. */
  readonly free?: boolean | undefined
}

/** The consent's hash for `routine` under `context`: prompt, runner, mode, model, cap, schedule and the key's name. */
export async function routineConsent(
  routine: Pick<Routine, "prompt" | "every" | "spend">,
  context: RoutineContext,
): Promise<string> {
  const offer = offerFor(context)
  return routineConsentHash({
    prompt: routine.prompt,
    runner: context.runner,
    mode: offer.mode,
    model: context.model ?? "",
    cap: JSON.stringify({ cap: offer.cap ?? null, spend: routine.spend ?? null, every: routine.every }),
    key: context.account?.mode === "key" ? context.account.key : undefined,
  })
}

/** Why a routine as drafted cannot be saved; undefined when it can. */
export function routineProblem(
  draft: Pick<Routine, "prompt" | "every" | "spend">,
  offer: RoutineOffer,
): string | undefined {
  if (!offer.allowed || !offer.cap) return offer.reason ?? t("bots.routine.problem.notAllowed")
  if (draft.prompt.trim().length === 0) return t("bots.routine.problem.prompt")
  if (!parseEvery(draft.every)) return t("bots.routine.problem.every")
  const cap = offer.cap
  if (draft.every.kind === "hours" && cap.minGapMin !== undefined && draft.every.hours * 60 < cap.minGapMin) {
    return t("bots.routine.problem.gap", cap.minGapMin)
  }
  if (cap.spendCapRequired) {
    const spend = draft.spend && parseSpend(draft.spend)
    if (!spend) return t("bots.routine.problem.spendRequired")
    if (cap.perRunUsd !== undefined && spend.perRunUsd > cap.perRunUsd)
      return t("bots.routine.problem.perRun", cap.perRunUsd)
    if (cap.perDayUsd !== undefined && spend.perDayUsd > cap.perDayUsd)
      return t("bots.routine.problem.perDay", cap.perDayUsd)
    if (spend.perRunUsd > spend.perDayUsd) return t("bots.routine.problem.runOverDay")
  }
  return undefined
}

/* ── when ─────────────────────────────────────────────────────────────── */

/** The local day of `at`, `YYYY-MM-DD`. */
export function dayOf(at: number): string {
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The moment of `HH:MM` on the local day of `at`. */
function slotOn(at: number, time: string): number {
  const [hours, minutes] = time.split(":").map(Number) as [number, number]
  const date = new Date(at)
  date.setHours(hours, minutes, 0, 0)
  return date.getTime()
}

/** The day after the local day of `at`, at the same time. */
function nextDay(at: number): number {
  const date = new Date(at)
  date.setDate(date.getDate() + 1)
  return date.getTime()
}

/**
 * How many of the routine's moments fell in `(from, to]`. A week at most is
 * counted: the number is only said, never made up.
 */
export function slotsBetween(every: RoutineEvery, from: number, to: number): number {
  if (to <= from) return 0
  if (every.kind === "hours") return Math.floor((to - from) / (every.hours * 3_600_000))
  let count = 0
  let slot = slotOn(from, every.at)
  if (slot <= from) slot = slotOn(nextDay(from), every.at)
  while (slot <= to && count < 400) {
    count++
    slot = slotOn(nextDay(slot), every.at)
  }
  return count
}

/** The next moment the routine is due after its last run (or its creation). */
export function nextRun(routine: Routine, log: RoutineLog | undefined, now: number): number {
  const base = log?.lastRunAt ?? routine.createdAt
  if (routine.every.kind === "hours") return Math.max(base + routine.every.hours * 3_600_000, now)
  let slot = slotOn(base, routine.every.at)
  if (slot <= base) slot = slotOn(nextDay(base), routine.every.at)
  return slot
}

/**
 * Whether the routine is due at `now`, and how many of its moments passed
 * besides the one it runs for: those are not made up (ADE was closed, or the
 * routine was held), only said.
 */
export function dueAt(routine: Routine, log: RoutineLog | undefined, now: number): { due: boolean; missed: number } {
  const slots = slotsBetween(routine.every, log?.lastRunAt ?? routine.createdAt, now)
  return { due: slots > 0, missed: Math.max(0, slots - 1) }
}

/* ── may it run now ───────────────────────────────────────────────────── */

export interface RoutineCheck {
  /** The bot as it is now; absent, its file is gone. */
  readonly context?: RoutineContext
  /** `routineConsent` now, for the context above. */
  readonly consent?: string
  /** A routine or the bot is running: one at a time. */
  readonly busy: boolean
}

export type RoutineVerdict =
  | {
      readonly kind: "run"
      readonly missed: number
      readonly plan: string
      readonly cap: RoutineCap
      readonly run: RoutineRun
    }
  | { readonly kind: "wait"; readonly note?: string }
  | { readonly kind: "suspend"; readonly reason: string }

/** The day's figures of `key`, from zero on a new day. */
export function planOn(book: RoutineBook, key: string, now: number): PlanLog {
  const plan = book.plans[key]
  const day = dayOf(now)
  return plan && plan.day === day ? plan : { day, runs: 0, spentUsd: 0 }
}

/** The day's figures of one routine, from zero on a new day. */
export function logOn(book: RoutineBook, id: string, now: number): RoutineLog {
  const log = book.logs[id] ?? EMPTY_LOG
  if (log.day === dayOf(now)) return log
  return { ...log, day: dayOf(now), runs: 0, spentUsd: 0 }
}

const usd = (value: number) => `${value.toFixed(2)} $`

/**
 * Asked before every run: the list, the consent, the caps, the plan's limit.
 * A routine the user must look at again is suspended; one that only has to
 * wait (a cap for today, another run under way) waits and says why.
 */
export function checkRoutine(book: RoutineBook, routine: Routine, check: RoutineCheck, now: number): RoutineVerdict {
  const log = logOn(book, routine.id, now)
  if (routine.paused || log.suspended) return { kind: "wait" }
  if (!dueAt(routine, log, now).due) return { kind: "wait" }
  if (!check.context) return { kind: "suspend", reason: t("bots.routine.suspended.noBot") }
  const offer = offerFor(check.context)
  if (!offer.allowed || !offer.cap)
    return { kind: "suspend", reason: offer.reason ?? t("bots.routine.problem.notAllowed") }
  if (!check.consent || check.consent !== routine.consent)
    return { kind: "suspend", reason: t("bots.routine.suspended.consent") }
  const cap = offer.cap
  if (cap.spendCapRequired && !routine.spend)
    return { kind: "suspend", reason: t("bots.routine.problem.spendRequired") }
  if (check.busy) return { kind: "wait" }
  const key = planKey(check.context.runner, offer.mode)
  const plan = planOn(book, key, now)
  if (plan.stopped) return { kind: "wait", note: t("bots.routine.note.limit") }
  if (cap.perDay !== undefined && plan.runs >= cap.perDay)
    return { kind: "wait", note: t("bots.routine.note.perDay", cap.perDay) }
  if (cap.minGapMin !== undefined && log.lastRunAt !== undefined && now - log.lastRunAt < cap.minGapMin * 60_000) {
    return { kind: "wait" }
  }
  if (routine.spend) {
    if (log.spentUsd + routine.spend.perRunUsd > routine.spend.perDayUsd) {
      return { kind: "wait", note: t("bots.routine.note.spendDay", usd(routine.spend.perDayUsd)) }
    }
    if (cap.perDayUsd !== undefined && plan.spentUsd + routine.spend.perRunUsd > cap.perDayUsd) {
      return { kind: "wait", note: t("bots.routine.note.spendDay", usd(cap.perDayUsd)) }
    }
  }
  /*
   * Money is capped per run where it is money: a paid model, a key. A free
   * model may spend nothing (review, M2). A plan's figure is not a charge.
   */
  const maxCostUsd =
    offer.mode === "free" ? 0 : offer.mode === "paid" || offer.mode === "key" ? routine.spend?.perRunUsd : undefined
  return {
    kind: "run",
    missed: dueAt(routine, log, now).missed,
    plan: key,
    cap,
    run: {
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
      ...(check.context.free !== undefined ? { free: check.context.free } : {}),
    },
  }
}

/* ── writing it down ──────────────────────────────────────────────────── */

function withLog(book: RoutineBook, id: string, log: RoutineLog): RoutineBook {
  return { ...book, logs: { ...book.logs, [id]: log } }
}

function withPlan(book: RoutineBook, key: string, plan: PlanLog): RoutineBook {
  return { ...book, plans: { ...book.plans, [key]: plan } }
}

/** A note on the routine, or the reason it is suspended. */
export function noteRoutine(
  book: RoutineBook,
  id: string,
  now: number,
  change: { note?: string; suspended?: string },
): RoutineBook {
  const log = book.logs[id] ?? EMPTY_LOG
  return withLog(book, id, {
    ...log,
    ...(change.note !== undefined ? { note: change.note, noteAt: now } : {}),
    ...(change.suspended !== undefined ? { suspended: change.suspended } : {}),
  })
}

/**
 * A run starts: it counts from now, so a run that never ends is still one of
 * the day's, and the next is due from here, whatever was missed.
 */
export function recordStart(
  book: RoutineBook,
  routine: Routine,
  key: string,
  missed: number,
  now: number,
): RoutineBook {
  const log = logOn(book, routine.id, now)
  const plan = planOn(book, key, now)
  const note = missed > 0 ? t("bots.routine.note.missed", missed) : t("bots.routine.note.running")
  return withPlan(withLog(book, routine.id, { ...log, lastRunAt: now, runs: log.runs + 1, note, noteAt: now }), key, {
    ...plan,
    runs: plan.runs + 1,
  })
}

/** A run ended: its cost, the plan's limit, a run that cost more than allowed. */
export function recordResult(
  book: RoutineBook,
  routine: Routine,
  key: string,
  result: Pick<TurnResult, "status" | "costUsd" | "limited" | "problem">,
  now: number,
): RoutineBook {
  const log = logOn(book, routine.id, now)
  const plan = planOn(book, key, now)
  const cost = finite(result.costUsd) && result.costUsd > 0 ? result.costUsd : 0
  const over = routine.spend !== undefined && cost > routine.spend.perRunUsd
  /* A free model that cost something is not free: the routine waits for the user (review, M2). */
  const notFree = key.endsWith(":free") && cost > 0
  const note = result.limited
    ? t("bots.routine.note.limit")
    : result.status === "done"
      ? t("bots.routine.note.done", cost > 0 ? usd(cost) : "")
      : result.status === "stopped"
        ? t("bots.routine.note.stopped")
        : t("bots.routine.note.failed", result.problem ?? "")
  const next = withPlan(book, key, {
    ...plan,
    spentUsd: plan.spentUsd + cost,
    ...(result.limited ? { stopped: true } : {}),
  })
  return withLog(next, routine.id, {
    ...log,
    spentUsd: log.spentUsd + cost,
    note,
    noteAt: now,
    ...(over && routine.spend
      ? { suspended: t("bots.routine.suspended.overRun", usd(cost), usd(routine.spend.perRunUsd)) }
      : {}),
    ...(notFree ? { suspended: t("bots.routine.suspended.notFree", usd(cost)) } : {}),
  })
}

/** The routine after the user agreed again: the new consent, and nothing held against it. */
export function reconsent(book: RoutineBook, id: string, consent: string): RoutineBook {
  const routines = book.routines.map((routine) => (routine.id === id ? { ...routine, consent } : routine))
  const log = book.logs[id]
  if (!log) return { ...book, routines }
  const { suspended: _gone, ...rest } = log
  return { ...book, routines, logs: { ...book.logs, [id]: rest } }
}

export function addRoutine(book: RoutineBook, routine: Routine): RoutineBook {
  return { ...book, routines: [...book.routines, routine] }
}

export function removeRoutine(book: RoutineBook, id: string): RoutineBook {
  const { [id]: _gone, ...logs } = book.logs
  return { ...book, routines: book.routines.filter((routine) => routine.id !== id), logs }
}

export function pauseRoutine(book: RoutineBook, id: string, paused: boolean): RoutineBook {
  return {
    ...book,
    routines: book.routines.map((routine) => {
      if (routine.id !== id) return routine
      if (paused) return { ...routine, paused: true }
      const { paused: _on, ...rest } = routine
      return rest
    }),
  }
}

/* ── the clock ────────────────────────────────────────────────────────── */

export interface RoutineSchedulerDeps {
  readonly store: RoutineStore
  /** The bot as it is on disk now; undefined when its file is gone. */
  readonly botOf: (path: string) => Promise<RoutineContext | undefined>
  /**
   * The checks a turn of the bot passes (trust, the bot's own grants, the
   * project), with no dialog: a routine never asks. A problem suspends it.
   * `context` is the bot as the file that will run says, read and trusted
   * just now: the consent is asked of it again.
   */
  readonly prepare: (
    routine: Routine,
  ) => Promise<{ ok: true; context: RoutineContext } | { ok: false; problem: string }>
  /** Starts the run as the bot's own turn, within `run`; undefined when the bot is busy. */
  readonly start: (routine: Routine, run: RoutineRun) => Turn | undefined
  /** Whether the bot has a turn under way. */
  readonly running: (path: string) => boolean
  readonly now?: () => number
  /** Told after every change to the book, for the panel. */
  readonly changed?: (book: RoutineBook) => void
}

export interface RoutineScheduler {
  /** Looks at every routine once; starts one at most. */
  tick: () => Promise<void>
  /** The routine's run under way, if any. */
  runningId: () => string | undefined
}

/**
 * The clock of the routines. It holds no timer: whoever creates it calls
 * `tick` while ADE is open, and nothing is left running when it closes.
 */
export function createRoutineScheduler(deps: RoutineSchedulerDeps): RoutineScheduler {
  const now = deps.now ?? Date.now
  let current: { id: string; turn: Turn } | undefined
  let ticking = false

  const write = (change: (book: RoutineBook) => RoutineBook) => {
    const next = change(deps.store.get())
    deps.store.set(next)
    deps.changed?.(next)
  }

  const tick = async () => {
    if (ticking) return
    ticking = true
    try {
      for (const routine of deps.store.get().routines) {
        const at = now()
        const book = deps.store.get()
        const log = logOn(book, routine.id, at)
        if (routine.paused || log.suspended || !dueAt(routine, log, at).due) continue
        const context = await deps.botOf(routine.bot)
        const consent = context ? await routineConsent(routine, context) : undefined
        const busy = current !== undefined || deps.running(routine.bot)
        const verdict = checkRoutine(
          deps.store.get(),
          routine,
          { ...(context ? { context } : {}), ...(consent ? { consent } : {}), busy },
          now(),
        )
        if (verdict.kind === "suspend") {
          write((latest) => noteRoutine(latest, routine.id, now(), { suspended: verdict.reason }))
          continue
        }
        if (verdict.kind === "wait") {
          if (verdict.note && log.note !== verdict.note)
            write((latest) => noteRoutine(latest, routine.id, now(), { note: verdict.note! }))
          continue
        }
        const prepared = await deps.prepare(routine)
        if (!prepared.ok) {
          write((latest) => noteRoutine(latest, routine.id, now(), { suspended: prepared.problem }))
          continue
        }
        /*
         * The file may have changed since `botOf` read it (B11 review,
         * BASSO 2): what runs is what `prepare` read, so the consent must hold
         * for that.
         */
        if ((await routineConsent(routine, prepared.context)) !== routine.consent) {
          write((latest) => noteRoutine(latest, routine.id, now(), { suspended: t("bots.routine.suspended.consent") }))
          continue
        }
        const turn = deps.start(routine, verdict.run)
        if (!turn) continue
        current = { id: routine.id, turn }
        write((latest) => recordStart(latest, routine, verdict.plan, verdict.missed, now()))
        void turn.result.then(
          (result) => {
            current = undefined
            write((latest) => recordResult(latest, routine, verdict.plan, result, now()))
          },
          () => {
            current = undefined
            write((latest) => recordResult(latest, routine, verdict.plan, { status: "error", costUsd: 0 }, now()))
          },
        )
        return
      }
    } finally {
      ticking = false
    }
  }

  return { tick, runningId: () => current?.id }
}

/* ── words for the panel ──────────────────────────────────────────────── */

export function describeEvery(every: RoutineEvery): string {
  return every.kind === "hours" ? t("bots.routine.everyHours", every.hours) : t("bots.routine.everyDaily", every.at)
}

/** The row's cap in one line: runs a day, the gap, the money. */
export function describeCap(cap: RoutineCap): string {
  const parts: string[] = []
  if (cap.perDay !== undefined) parts.push(t("bots.routine.cap.perDay", cap.perDay))
  if (cap.minGapMin !== undefined) parts.push(t("bots.routine.cap.gap", cap.minGapMin))
  if (cap.perRunUsd !== undefined && cap.perDayUsd !== undefined)
    parts.push(t("bots.routine.cap.money", cap.perRunUsd, cap.perDayUsd))
  return parts.join("; ")
}

/** Whether the runner's routines only read (`TurnSpec.unattended`): all three, nikcli by `bot-read-only`. */
export function routineReadOnly(runner: string): boolean {
  return runner === "claude" || runner === "codex" || runner === "nikcli"
}

export function modeLabel(mode: RoutineMode): string {
  return t(`bots.routine.mode.${mode}`)
}

/** When the next run is: a time today, tomorrow, or a date. */
export function formatNext(at: number, now: number): string {
  const date = new Date(at)
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  if (dayOf(at) === dayOf(now)) return time
  if (dayOf(at) === dayOf(nextDay(now))) return t("bots.routine.tomorrow", time)
  return `${date.getDate()} ${t("bots.when.month", date.getMonth())} ${time}`
}
