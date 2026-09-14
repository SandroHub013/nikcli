import { createSignal, onCleanup, type Accessor } from "solid-js"

/**
 * Short "how long ago" labels, in the caller's language.
 *
 * Three near-identical copies of this had grown — the session sidebar, the
 * routines dialog and the desktop shell — and two other places reached for
 * luxon's `toRelative`, which is why luxon sat in the entry chunk.
 *
 * It was English-only for a while, on the belief that no locale data produces
 * the two-character form. That was wrong: `Intl.NumberFormat` with a unit and
 * `unitDisplay: "narrow"` gives exactly it — `7h` in English, `3gg` in Italian,
 * `3天` in Chinese, `٧ س` in Arabic. Some locales are wider than English; that is
 * the correct label for them, and the row truncates rather than lying.
 *
 * The full phrase — "7 hours ago" — lives in `intl-time.ts`. This is only the
 * dense form, for rows that sit beside a title.
 */

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

type Unit = "hour" | "minute" | "day" | "week"

const unitFormat = (() => {
  const cache = new Map<string, Intl.NumberFormat>()
  return (locale: string, unit: Unit) => {
    const key = `${locale}\u0000${unit}`
    let format = cache.get(key)
    if (!format) {
      format = new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow", useGrouping: false })
      cache.set(key, format)
    }
    return format
  }
})()

const nowFormat = (() => {
  const cache = new Map<string, Intl.RelativeTimeFormat>()
  return (locale: string) => {
    let format = cache.get(locale)
    if (!format) {
      format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" })
      cache.set(locale, format)
    }
    return format
  }
})()

export function relativeTime(timestamp: number | undefined, now: number = Date.now(), locale = "en"): string | undefined {
  if (!timestamp) return undefined

  // The clamp is defensive, not load-bearing: any negative value is already
  // below the first threshold, so a skewed clock reads as "now" either way.
  // Kept so a future threshold change cannot turn clock skew into "-2h".
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))

  if (seconds < MINUTE) return nowFormat(locale).format(0, "second")
  if (seconds < HOUR) return unitFormat(locale, "minute").format(Math.floor(seconds / MINUTE))
  if (seconds < DAY) return unitFormat(locale, "hour").format(Math.floor(seconds / HOUR))
  if (seconds < WEEK) return unitFormat(locale, "day").format(Math.floor(seconds / DAY))
  return unitFormat(locale, "week").format(Math.floor(seconds / WEEK))
}

/**
 * A clock shared by every caller.
 *
 * Relative labels go stale silently, so they need something to invalidate them —
 * but a timer per session row would mean dozens of them. Subscribers share one
 * interval, and it stops as soon as the last one goes away.
 */
const TICK_MS = 30_000
const [now, setNow] = createSignal(Date.now())
let subscribers = 0
let timer: ReturnType<typeof setInterval> | undefined

export function useNow(): Accessor<number> {
  subscribers += 1
  if (timer === undefined) {
    setNow(Date.now())
    timer = setInterval(() => setNow(Date.now()), TICK_MS)
  }

  onCleanup(() => {
    subscribers -= 1
    if (subscribers > 0 || timer === undefined) return
    clearInterval(timer)
    timer = undefined
  })

  return now
}

/** Test seam: the module-level clock outlives individual tests. */
export function __resetClockForTests() {
  if (timer !== undefined) clearInterval(timer)
  timer = undefined
  subscribers = 0
}
