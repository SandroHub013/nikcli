/**
 * Dates, relative times and durations, from the platform rather than a library.
 *
 * These three shapes were the only thing luxon was doing — 68 kB fetched as soon
 * as a session opens, because the empty state prints "last modified 7 hours ago".
 * `Intl` does all of it, is locale-aware in the same way, and costs nothing.
 *
 * Formatters are memoised per locale: constructing one is the expensive part,
 * and the transcript re-renders a duration on every tick while a turn runs.
 *
 * Distinct from `relative-time.ts`, which prints the two-character form ("7h")
 * that dense rows need and that no locale data produces. See the note there.
 */

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
// Average lengths, not 30 and 365. Fixed 30-day months read a 5-month-27-day
// gap as "6 months ago" — older than it is, which the truncation below exists to
// prevent — and make twelve months shorter than one year, so "12 months ago" was
// reachable at all.
const MONTH = (365.25 / 12) * DAY
const YEAR = 365.25 * DAY

/**
 * The app's locale ids, translated to tags `Intl` understands.
 *
 * Two of the sixteen are not the BCP-47 tag they look like. `zht` is not a tag
 * at all, so `Intl` discards it and falls back to the *viewer's system locale* —
 * a Traditional Chinese user was shown whatever language the machine runs in.
 * `br` is a valid tag, which is worse: it means Breton, so dates rendered as
 * "19 Eost 2026" instead of Brazilian Portuguese.
 *
 * Both predate this module — luxon did exactly the same — but this is now the
 * one place every date, duration and relative label passes through.
 */
const LOCALE_TAG: Readonly<Record<string, string>> = {
  zht: "zh-Hant",
  zh: "zh-Hans",
  br: "pt-BR",
}

function tagFor(locale: string): string {
  return LOCALE_TAG[locale] ?? locale
}

function memoise<T>(build: (locale: string) => T): (locale: string) => T {
  const cache = new Map<string, T>()
  return (locale: string) => {
    let value = cache.get(locale)
    if (value === undefined) {
      value = build(locale)
      cache.set(locale, value)
    }
    return value
  }
}

/**
 * `numeric: "always"`, deliberately.
 *
 * With `"auto"`, `Intl` reaches for calendar words: eight days ago and thirteen
 * days ago both render as "last week", and fifty-nine days as "last month". The
 * lists this feeds — recent projects, last modified — exist to order things by
 * how recent they are, and that wording collapses the ordering. It also asserts
 * something false: fifty-nine days back is two calendar months, not one.
 */
const relativeFormat = memoise((locale) => new Intl.RelativeTimeFormat(locale, { numeric: "always" }))

/**
 * Only for the sub-second case, where "always" says "in 0 seconds" and the word
 * the user wants is "now".
 */
const nowFormat = memoise((locale) => new Intl.RelativeTimeFormat(locale, { numeric: "auto" }))
const dateTimeFormat = memoise((key: string) => {
  const [locale, timeZone] = key.split('\u0000')
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: timeZone || undefined })
})
const unitFormat = memoise((key: string) => {
  const [locale, unit] = key.split("\u0000") as [string, Intl.NumberFormatOptions["unit"]]
  // No grouping separator: a long turn read "1,666m 40s", and in German
  // "1.666 Min.", where the dot looks like a decimal point.
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow", useGrouping: false })
})

/** The largest unit that fits, so an hour-old thing does not read as "60 minutes ago". */
const SCALE: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", YEAR],
  ["month", MONTH],
  // No week step: it turns "29 days ago" into "4 weeks ago", which is coarser
  // without being shorter, and days carry straight through to months.
  ["day", DAY],
  ["hour", HOUR],
  ["minute", MINUTE],
  ["second", SECOND],
]

/** "7 hours ago", in the caller's language. */
export function formatRelativeTime(timestamp: number, locale: string, now: number = Date.now()): string {
  const delta = timestamp - now
  const magnitude = Math.abs(delta)
  for (const [unit, size] of SCALE) {
    if (magnitude >= size) {
      // Truncate towards zero: 90 minutes is "1 hour ago", never "2 hours ago".
          return relativeFormat(tagFor(locale)).format(Math.trunc(delta / size), unit)
    }
  }
  // Under a second, in either direction.
  return nowFormat(tagFor(locale)).format(0, "second")
}

/** A medium-length absolute date and time. */
export function formatDateTime(timestamp: number, locale: string, timeZone?: string): string {
  // The zone is a test seam: without pinning it the expected string depends on
  // where the suite runs.
  return dateTimeFormat(`${tagFor(locale)}\u0000${timeZone ?? ""}`).format(timestamp)
}

/**
 * How long a turn took: "14s" under a minute, "2m 14s" above it.
 *
 * Joined with a space rather than through `Intl.ListFormat`, which inserts a
 * separator — the previous implementation had to strip the ideographic comma
 * back out for Chinese.
 */
export function formatDuration(milliseconds: number, locale: string): string {
  const total = Math.max(0, Math.round(milliseconds / SECOND))
  const format = (value: number, unit: "minute" | "second") =>
    unitFormat(`${tagFor(locale)}\u0000${unit}`).format(value)

  if (total < 60) return format(total, "second")
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  // Zero seconds is noise on a round duration.
  return seconds === 0 ? format(minutes, "minute") : `${format(minutes, "minute")} ${format(seconds, "second")}`
}
