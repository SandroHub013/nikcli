import { describe, expect, test } from "bun:test"
import { DateTime } from "luxon"
import { isValidReleaseDate, monthsSinceRelease, parseReleaseDate } from "./release-date"

/**
 * These helpers replaced luxon in the model list so it would stop landing in the
 * app's entry chunk. Luxon is still a dependency of the session views, so the
 * equivalence is asserted against it directly rather than assumed.
 */
const CORPUS = [
  // Real shapes seen in the models database.
  "2025-03-01",
  "2024-11-15",
  "2026-02-12",
  "2020-01-01",
  "2026-08-19",
  "2024-02-29",
  // Partial ISO dates luxon still accepts.
  "2025",
  "2025-03",
  // Things a provider deriving the field from a version string can produce.
  "1",
  "",
  "gpt-4o",
  "not-a-date",
  "March 1 2025",
  "2025-13-01",
  "2025-02-31",
  "2025-00-10",
]

/**
 * Two inputs are handled deliberately differently from luxon. Neither can come
 * out of the models database — both are asserted so the divergence is a decision
 * on record rather than a latent surprise.
 */
const DELIBERATE_DIVERGENCE = [
  // Luxon keeps the time; the helper works at day precision.
  { value: "2025-03-01T12:30:00", luxonValid: true, helperValid: true },
  // Luxon accepts year zero; JS `Date` would remap it into the 1900s.
  { value: "0000-01-01", luxonValid: true, helperValid: false },
]

describe("parity with luxon", () => {
  test.each(CORPUS)("validity of %p matches DateTime.fromISO", (value) => {
    expect(isValidReleaseDate(value)).toBe(DateTime.fromISO(value).isValid)
  })

  test.each(CORPUS)("month distance of %p matches diffNow().as('months')", (value) => {
    const parsed = DateTime.fromISO(value)
    if (!parsed.isValid) {
      expect(monthsSinceRelease(value)).toBeUndefined()
      return
    }
    const now = Date.now()
    // Luxon measures from the date to now, the helper the other way round; the
    // caller compares the absolute value.
    const expected = -parsed.diffNow().as("months")
    const actual = monthsSinceRelease(value, now)!
    // Each side reads the clock separately, so allow a little drift.
    expect(Math.abs(actual - expected)).toBeLessThan(1e-6)
  })

  test.each(DELIBERATE_DIVERGENCE)("$value diverges from luxon on purpose", (Case) => {
    expect(DateTime.fromISO(Case.value).isValid).toBe(Case.luxonValid)
    expect(isValidReleaseDate(Case.value)).toBe(Case.helperValid)
  })

  test("a time component only shifts the result within the same day", () => {
    const now = Date.now()
    const withTime = monthsSinceRelease("2025-03-01T12:30:00", now)!
    const dateOnly = monthsSinceRelease("2025-03-01", now)!
    expect(withTime).toBe(dateOnly)
    // Half a day, expressed in luxon's 30-day months.
    expect(Math.abs(withTime - -DateTime.fromISO("2025-03-01T12:30:00").diffNow().as("months"))).toBeLessThan(1 / 30)
  })

  test("the six-month cut-off selects the same models as luxon did", () => {
    const now = Date.now()
    for (const value of CORPUS) {
      const parsed = DateTime.fromISO(value)
      if (!parsed.isValid) continue
      const luxonWithin = Math.abs(parsed.diffNow().as("months")) < 6
      const helperWithin = Math.abs(monthsSinceRelease(value, now)!) < 6
      expect(`${value}:${helperWithin}`).toBe(`${value}:${luxonWithin}`)
    }
  })
})

describe("parseReleaseDate", () => {
  test("resolves a calendar date to local midnight", () => {
    expect(parseReleaseDate("2025-03-01")).toBe(new Date(2025, 2, 1).getTime())
  })

  test("defaults a missing month and day to January 1st", () => {
    expect(parseReleaseDate("2025")).toBe(new Date(2025, 0, 1).getTime())
    expect(parseReleaseDate("2025-03")).toBe(new Date(2025, 2, 1).getTime())
  })

  test("rejects a day that would roll into the next month", () => {
    expect(parseReleaseDate("2025-02-31")).toBeUndefined()
    expect(parseReleaseDate("2025-04-31")).toBeUndefined()
  })

  test("accepts a real leap day", () => {
    expect(parseReleaseDate("2024-02-29")).toBe(new Date(2024, 1, 29).getTime())
  })

  test("treats empty and nullish input as unknown", () => {
    expect(parseReleaseDate(undefined)).toBeUndefined()
    expect(parseReleaseDate(null)).toBeUndefined()
    expect(parseReleaseDate("")).toBeUndefined()
  })
})
