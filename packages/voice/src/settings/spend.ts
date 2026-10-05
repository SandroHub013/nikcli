/**
 * What listening for the name has cost today.
 *
 * Every sentence the room says while the assistant waits to be called is a
 * paid transcription — the user's own OpenRouter credit — and until now
 * nothing said so. The count and the cost of the day are kept here, written
 * where the settings are, so closing ADE does not hide what it spent.
 *
 * Only what the voice sends to OpenRouter: a turn the user asked for on a
 * subscription is not in here.
 *
 * The voice of the replies (MAI) is counted in the same day, so the panel says
 * one figure for what the voice spent. Its own share is kept apart as well,
 * because its daily cap is about the replies only: `calls`/`cost` are the whole
 * day, `replyCalls`/`replyCost` the part of it the replies took. Listening adds
 * through `add`/`addCost`, the replies through `addReply`/`settleReply`, and the
 * cap compares `replyCost` (see `maiCapReached` in `tts/mai.ts`).
 *
 * Streamed transcription is counted apart, and in none of the figures above:
 * it is not OpenRouter's, and `calls`/`cost` are what the voice sent to
 * OpenRouter. It is the seconds of audio the socket really carried, at the
 * hourly rate, in `streamSeconds`/`streamCost`; the day's cap on it
 * (`streamDailyCapUsd`) compares `streamCost` and nothing else, so what the
 * replies or the fallback spent on OpenRouter never eats into it.
 */

import { STREAM_BYTES_PER_SECOND, STREAM_USD_PER_HOUR } from "../asr/grok-stream"

export const VOICE_SPEND_STORAGE_KEY = "voice.listenSpend"

export interface DaySpend {
  /** The day these belong to, as `YYYY-MM-DD` in the machine's own time. */
  readonly day: string
  /** Requests sent to OpenRouter by listening or the planner. */
  readonly calls: number
  /** What those requests cost, in dollars, as the service reported it. */
  readonly cost: number
  /** Of those, the requests made by the voice of the replies. */
  readonly replyCalls?: number
  /** And what they cost: reserved before each request, settled after it. */
  readonly replyCost?: number
  /** The generation ids already settled today, so settling one twice changes nothing. */
  readonly settled?: readonly string[]
  /** Seconds of audio the streaming socket carried today, counted from what was sent. */
  readonly streamSeconds?: number
  /** What those seconds cost, in dollars, at the streaming rate. Not part of `cost`. */
  readonly streamCost?: number
}

export const emptyDay = (day: string): DaySpend => ({ day, calls: 0, cost: 0 })

/** How many settled ids a day keeps: more replies than a day has, few enough to stay small in storage. */
const SETTLED_KEPT = 500

const count = (value: unknown): number => (typeof value === "number" && value >= 0 ? Math.floor(value) : 0)
const money = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0

/** Seconds of 16 kHz mono PCM16 in `bytes`: what the socket carried. */
export function streamSecondsOf(bytes: number): number {
  return money(bytes) / STREAM_BYTES_PER_SECOND
}

/** Dollars `seconds` of streamed audio cost, at `STREAM_USD_PER_HOUR`. */
export function streamCostOf(seconds: number): number {
  return (money(seconds) * STREAM_USD_PER_HOUR) / 3600
}

/**
 * Whether streaming has spent its day. A cap of 0 is spent from the start, which
 * is how streaming is turned off; the amount is compared as it is stored.
 */
export function streamCapReached(spend: DaySpend, capUsd: number): boolean {
  return (spend.streamCost ?? 0) >= capUsd
}

/** The local day of `at`: the user's day, not UTC's. */
export function dayOf(at: number): string {
  const date = new Date(at)
  const month = `${date.getMonth() + 1}`.padStart(2, "0")
  return `${date.getFullYear()}-${month}-${`${date.getDate()}`.padStart(2, "0")}`
}

/** A stored value that is not a day's spending is one: today, from nothing. */
export function readDaySpend(raw: string | null, at: number): DaySpend {
  const today = dayOf(at)
  if (!raw) return emptyDay(today)
  try {
    const parsed = JSON.parse(raw) as Partial<DaySpend>
    if (typeof parsed?.day !== "string" || parsed.day !== today) return emptyDay(today)
    const day: DaySpend = { day: today, calls: count(parsed.calls), cost: money(parsed.cost) }
    const replyCalls = count(parsed.replyCalls)
    const replyCost = money(parsed.replyCost)
    const streamSeconds = money(parsed.streamSeconds)
    const streamCost = money(parsed.streamCost)
    const settled = Array.isArray(parsed.settled)
      ? parsed.settled.filter((id): id is string => typeof id === "string").slice(-SETTLED_KEPT)
      : []
    return {
      ...day,
      ...(replyCalls > 0 ? { replyCalls } : {}),
      ...(replyCost > 0 ? { replyCost } : {}),
      ...(settled.length > 0 ? { settled } : {}),
      ...(streamSeconds > 0 ? { streamSeconds } : {}),
      ...(streamCost > 0 ? { streamCost } : {}),
    }
  } catch {
    return emptyDay(today)
  }
}

/** One more request, and what it cost; a new day starts from nothing. */
export function addSpend(spend: DaySpend, at: number, cost: number | undefined): DaySpend {
  const today = dayOf(at)
  const base = spend.day === today ? spend : emptyDay(today)
  return { ...base, calls: base.calls + 1, cost: base.cost + (typeof cost === "number" && cost > 0 ? cost : 0) }
}

/** One request of the voice of the replies, at what it was reserved for: in the day, and in its own share. */
export function addReplySpend(spend: DaySpend, at: number, reserved: number): DaySpend {
  const counted = addSpend(spend, at, reserved)
  return {
    ...counted,
    replyCalls: (counted.replyCalls ?? 0) + 1,
    replyCost: (counted.replyCost ?? 0) + money(reserved),
  }
}

/**
 * Seconds of audio the streaming socket really carried, and what they cost at
 * the hourly rate. Counted on their own: `calls` and `cost` are OpenRouter's.
 */
export function addStreamSpend(spend: DaySpend, at: number, seconds: number): DaySpend {
  const today = dayOf(at)
  const base = spend.day === today ? spend : emptyDay(today)
  const carried = money(seconds)
  if (carried === 0) return base
  return {
    ...base,
    streamSeconds: (base.streamSeconds ?? 0) + carried,
    streamCost: (base.streamCost ?? 0) + streamCostOf(carried),
  }
}

/**
 * What a reply request really cost, once OpenRouter says it: `delta` is that
 * minus the reservation, applied to the day the request was sent on. A later
 * day has nothing of it, so it is left alone; an id already settled is too.
 */
export function settleReplySpend(spend: DaySpend, id: string, sentAt: number, delta: number): DaySpend {
  if (spend.day !== dayOf(sentAt)) return spend
  if (spend.settled?.includes(id)) return spend
  if (!Number.isFinite(delta)) return spend
  const settled = [...(spend.settled ?? []), id].slice(-SETTLED_KEPT)
  return {
    ...spend,
    cost: Math.max(0, spend.cost + delta),
    replyCost: Math.max(0, (spend.replyCost ?? 0) + delta),
    settled,
  }
}

/**
 * The day's cost as money, for the panel: two decimals, and anything below a
 * cent said as such rather than shown as «0,00 $», which reads as free.
 */
export function formatSpendCost(cost: number, locale?: string): string {
  const money = (value: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      // «0,02 $» in Italian, as the texts beside it write it, not «0,02 USD» (S8).
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value)
  return cost > 0 && cost < 0.01 ? `< ${money(0.01)}` : money(cost)
}

export interface SpendTally {
  /** What has been spent today, whatever day it is now. */
  today(at: number): DaySpend
  /** Counts one OpenRouter request. */
  add(at: number, cost: number | undefined): DaySpend
  /** Adds the cost reported for a request already counted. */
  addCost(at: number, cost: number): DaySpend
  /** Counts seconds of audio the streaming socket carried; see `addStreamSpend`. */
  addStream(at: number, seconds: number): DaySpend
  /** Counts one request of the voice of the replies, reserved before it goes out. */
  addReply(at: number, reserved: number): DaySpend
  /** Corrects a reply request by what it really cost; see `settleReplySpend`. */
  settleReply(id: string, sentAt: number, delta: number, now: number): DaySpend
  /**
   * Called after every change, whoever made it. Listening and the replies write
   * the same day; this is how each one's view of it stays the whole of it.
   */
  onChange(listener: (spend: DaySpend) => void): () => void
}

/**
 * The tally, kept in storage so it survives a restart of the app.
 *
 * Without storage — a private window, a test — it still counts, for as long
 * as the window is open.
 */
export function createSpendTally(storage: Storage | null, at: number): SpendTally {
  const read = (): string | null => {
    try {
      return storage?.getItem(VOICE_SPEND_STORAGE_KEY) ?? null
    } catch {
      return null
    }
  }
  let spend = readDaySpend(read(), at)
  const listeners = new Set<(spend: DaySpend) => void>()
  const write = () => {
    try {
      storage?.setItem(VOICE_SPEND_STORAGE_KEY, JSON.stringify(spend))
    } catch {
      // A full or refused storage must not stop the voice from listening.
    }
    for (const listener of listeners) listener(spend)
  }
  return {
    today(now: number): DaySpend {
      if (spend.day !== dayOf(now)) spend = emptyDay(dayOf(now))
      return spend
    },
    add(now: number, cost: number | undefined): DaySpend {
      spend = addSpend(spend, now, cost)
      write()
      return spend
    },
    addCost(now: number, cost: number): DaySpend {
      const today = dayOf(now)
      const base = spend.day === today ? spend : emptyDay(today)
      spend = { ...base, cost: base.cost + (cost > 0 ? cost : 0) }
      write()
      return spend
    },
    addStream(now: number, seconds: number): DaySpend {
      const next = addStreamSpend(spend, now, seconds)
      if (next === spend) return spend
      spend = next
      write()
      return spend
    },
    addReply(now: number, reserved: number): DaySpend {
      spend = addReplySpend(spend, now, reserved)
      write()
      return spend
    },
    settleReply(id: string, sentAt: number, delta: number, now: number): DaySpend {
      if (spend.day !== dayOf(now)) spend = emptyDay(dayOf(now))
      const next = settleReplySpend(spend, id, sentAt, delta)
      if (next === spend) return spend
      spend = next
      write()
      return spend
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
