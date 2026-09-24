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
 */

export const VOICE_SPEND_STORAGE_KEY = "voice.listenSpend"

export interface DaySpend {
  /** The day these belong to, as `YYYY-MM-DD` in the machine's own time. */
  readonly day: string
  /** Requests sent to OpenRouter by listening or the planner. */
  readonly calls: number
  /** What those requests cost, in dollars, as the service reported it. */
  readonly cost: number
}

export const emptyDay = (day: string): DaySpend => ({ day, calls: 0, cost: 0 })

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
    const calls = typeof parsed.calls === "number" && parsed.calls >= 0 ? Math.floor(parsed.calls) : 0
    const cost = typeof parsed.cost === "number" && parsed.cost >= 0 ? parsed.cost : 0
    return { day: today, calls, cost }
  } catch {
    return emptyDay(today)
  }
}

/** One more request, and what it cost; a new day starts from nothing. */
export function addSpend(spend: DaySpend, at: number, cost: number | undefined): DaySpend {
  const today = dayOf(at)
  const base = spend.day === today ? spend : emptyDay(today)
  return { day: today, calls: base.calls + 1, cost: base.cost + (typeof cost === "number" && cost > 0 ? cost : 0) }
}

/**
 * The day's cost as money, for the panel: two decimals, and anything below a
 * cent said as such rather than shown as «0,00 $», which reads as free.
 */
export function formatSpendCost(cost: number, locale?: string): string {
  const money = (value: number) =>
    new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
  return cost > 0 && cost < 0.01 ? `< ${money(0.01)}` : money(cost)
}

export interface SpendTally {
  /** What has been spent today, whatever day it is now. */
  today(at: number): DaySpend
  /** Counts one OpenRouter request. */
  add(at: number, cost: number | undefined): DaySpend
  /** Adds the cost reported for a request already counted. */
  addCost(at: number, cost: number): DaySpend
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
  const write = () => {
    try {
      storage?.setItem(VOICE_SPEND_STORAGE_KEY, JSON.stringify(spend))
    } catch {
      // A full or refused storage must not stop the voice from listening.
    }
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
  }
}
