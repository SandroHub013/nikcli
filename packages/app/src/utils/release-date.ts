/**
 * Release dates arrive as ISO calendar dates, but some providers derive the
 * field from a version string, so anything can turn up and validity has to be
 * checked. This replaces the two luxon calls the model list used to make: luxon
 * was otherwise unreachable from the app shell, and pulling it into the entry
 * chunk cost more than this arithmetic.
 *
 * Behaviour matches `DateTime.fromISO(value)` for the formats that occur here —
 * `release-date.test.ts` asserts that against luxon directly.
 */

/**
 * Year, year-month, or full calendar date, optionally followed by a time.
 *
 * A time component is accepted but ignored: every real value here is date-only,
 * and day precision cannot move a model across the six-month cut-off in any way
 * that matters. Years below 1000 are rejected — no release date is prehistoric,
 * and JS `Date` remaps two-digit years into the 1900s.
 */
const ISO_CALENDAR_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:[T ][\d:.,+\-Z]*)?$/

/** Local midnight, matching how luxon resolves a zone-less ISO date. */
export function parseReleaseDate(value: string | undefined | null): number | undefined {
  if (!value) return undefined
  const match = ISO_CALENDAR_DATE.exec(value)
  if (!match) return undefined

  const year = Number(match[1])
  if (year < 1000) return undefined
  const month = match[2] === undefined ? 1 : Number(match[2])
  const day = match[3] === undefined ? 1 : Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined

  const date = new Date(year, month - 1, day)
  // Rejects overflow like 2025-02-31, which JS would otherwise roll forward.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined
  return date.getTime()
}

export function isValidReleaseDate(value: string | undefined | null): boolean {
  return parseReleaseDate(value) !== undefined
}

/** Luxon converts a plain millisecond duration to months at 30 days per month. */
const MONTH_MS = 30 * 24 * 60 * 60 * 1000

/** Months between the release date and `now`; negative for future dates. */
export function monthsSinceRelease(value: string | undefined | null, now: number = Date.now()): number | undefined {
  const time = parseReleaseDate(value)
  if (time === undefined) return undefined
  return (now - time) / MONTH_MS
}
