import { describe, expect, test } from "bun:test"
import { formatDateTime, formatDuration, formatRelativeTime } from "./intl-time"

const NOW = Date.UTC(2026, 7, 19, 12, 0, 0)
const ago = (ms: number) => NOW - ms

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe("formatRelativeTime", () => {
  test.each([
    [0, "now"],
    [SECOND, "1 second ago"],
    [59 * SECOND, "59 seconds ago"],
    [MINUTE, "1 minute ago"],
    [90 * MINUTE, "1 hour ago"],
    [HOUR, "1 hour ago"],
    [7 * HOUR, "7 hours ago"],
    // Days run straight through to months: no week step, and no calendar
    // wording. Both would collapse the ordering these lists exist to show.
    [DAY, "1 day ago"],
    [3 * DAY, "3 days ago"],
    [8 * DAY, "8 days ago"],
    [13 * DAY, "13 days ago"],
    [29 * DAY, "29 days ago"],
    [59 * DAY, "1 month ago"],
    [180 * DAY, "5 months ago"],
    [364 * DAY, "11 months ago"],
    [400 * DAY, "1 year ago"],
  ])("%i ms ago reads %p", (delta, expected) => {
    expect(formatRelativeTime(ago(delta), "en", NOW)).toBe(expected)
  })

  test("picks the largest unit that fits, so an hour is not sixty minutes", () => {
    expect(formatRelativeTime(ago(HOUR), "en", NOW)).not.toContain("minute")
    expect(formatRelativeTime(ago(DAY), "en", NOW)).not.toContain("hour")
  })

  test("never reads as older than it is", () => {
    // Months are an average length, not a flat thirty days. With thirty, a gap
    // of five months and twenty-seven days rendered as "6 months ago", and
    // twelve months was shorter than a year, so "12 months ago" existed.
    expect(formatRelativeTime(ago(180 * DAY), "en", NOW)).toBe("5 months ago")
    expect(formatRelativeTime(ago(360 * DAY), "en", NOW)).not.toContain("12")
    for (let days = 1; days <= 800; days++) {
      expect(formatRelativeTime(ago(days * DAY), "en", NOW)).not.toContain("12 months")
    }
  })

  test("truncates rather than rounds, so nothing reads as older than it is", () => {
    // 119 minutes is one hour and fifty-nine, not two hours.
    expect(formatRelativeTime(ago(119 * MINUTE), "en", NOW)).toBe("1 hour ago")
  })

  test("handles a timestamp in the future without counting backwards into nonsense", () => {
    expect(formatRelativeTime(NOW + 2 * HOUR, "en", NOW)).toBe("in 2 hours")
    expect(formatRelativeTime(NOW + 500, "en", NOW)).toBe("now")
    // Truncation has to hold in the future direction too: rounding would make
    // two and a half hours from now read as three.
    expect(formatRelativeTime(NOW + 2.5 * HOUR, "en", NOW)).toBe("in 2 hours")
    expect(formatRelativeTime(NOW + 59 * MINUTE, "en", NOW)).toBe("in 59 minutes")
  })

  test("a month is an average month, not thirty days", () => {
    // 31 days would put the boundary in the wrong place: this is the first day
    // that reads as a month, and it is not the thirty-first.
    expect(formatRelativeTime(ago(30 * DAY), "en", NOW)).toBe("30 days ago")
    expect(formatRelativeTime(ago(31 * DAY), "en", NOW)).toBe("1 month ago")
    // 61 days is the first value where a flat 31-day month disagrees: two
    // average months have passed, but only one thirty-one-day one. Without this
    // the boundary above holds for either length and pins nothing.
    expect(formatRelativeTime(ago(61 * DAY), "en", NOW)).toBe("2 months ago")
    expect(formatRelativeTime(ago(214 * DAY), "en", NOW)).toBe("7 months ago")
  })

  test("speaks the caller's language", () => {
    expect(formatRelativeTime(ago(7 * HOUR), "it", NOW)).toBe("7 ore fa")
    expect(formatRelativeTime(ago(7 * HOUR), "fr", NOW)).toBe("il y a 7 heures")
    expect(formatRelativeTime(ago(DAY), "de", NOW)).toBe("vor 1 Tag")
  })

  test("an unknown locale falls back rather than throwing", () => {
    expect(() => formatRelativeTime(ago(HOUR), "zz", NOW)).not.toThrow()
  })
})

describe("formatter reuse", () => {
  test("builds one formatter per locale, not one per call", () => {
    // The transcript re-renders a duration every second while a turn runs, and
    // constructing an Intl formatter is the expensive part. Deleting the
    // memoisation left every test green.
    const real = Intl.NumberFormat
    let built = 0
    // @ts-expect-error replacing a global constructor for the length of the test
    Intl.NumberFormat = function (...args: unknown[]) {
      built += 1
      // @ts-expect-error forwarding to the real constructor
      return new real(...args)
    }
    try {
      for (let i = 0; i < 50; i++) formatDuration(134 * SECOND, "en")
      // Two units, one formatter each.
      expect(built).toBeLessThanOrEqual(2)
    } finally {
      Intl.NumberFormat = real
    }
  })
})

describe("formatDuration", () => {
  test.each([
    [0, "0s"],
    [400, "0s"],
    [900, "1s"],
    [14 * SECOND, "14s"],
    [59 * SECOND, "59s"],
    [60 * SECOND, "1m"],
    [134 * SECOND, "2m 14s"],
    [120 * SECOND, "2m"],
    [3600 * SECOND, "60m"],
  ])("%i ms reads %p", (ms, expected) => {
    expect(formatDuration(ms, "en")).toBe(expected)
  })

  test("a round number of minutes does not trail a zero", () => {
    expect(formatDuration(5 * MINUTE, "en")).toBe("5m")
    expect(formatDuration(5 * MINUTE + SECOND, "en")).toBe("5m 1s")
  })

  test("never goes negative when the clock moves under it", () => {
    expect(formatDuration(-5000, "en")).toBe("0s")
  })

  test("joins without a list separator, which Chinese used to need stripped", () => {
    const zh = formatDuration(134 * SECOND, "zh")
    expect(zh).not.toContain("\u3001")
    expect(zh.split(" ")).toHaveLength(2)
  })
})

describe("formatDateTime", () => {
  test("matches the medium form the app used before, exactly", () => {
    // The swap away from luxon's DATETIME_MED is only sound if the output is the
    // same shape. Asserted as one exact string, because "contains 2026" passed
    // just as happily for a full-length date with a weekday in it.
    expect(formatDateTime(Date.UTC(2026, 7, 19, 14, 5), "en-US", "UTC")).toBe("Aug 19, 2026, 2:05 PM")
    expect(formatDateTime(Date.UTC(2026, 7, 19, 14, 5), "en-GB", "UTC")).toBe("19 Aug 2026, 14:05")
  })

  test("follows the locale's conventions rather than one fixed order", () => {
    expect(formatDateTime(NOW, "en-US")).not.toBe(formatDateTime(NOW, "de-DE"))
  })
})

describe("locale tags the app uses", () => {
  test("zht is Traditional Chinese, not the viewer's system language", () => {
    // `zht` is not a BCP-47 tag: Intl discards it and falls back to whatever the
    // machine runs, so this read as Italian on the machine it was found on.
    const out = formatRelativeTime(ago(7 * HOUR), "zht", NOW)
    expect(out).toContain("小時")
    expect(out).not.toMatch(/[a-z]{3,}/)
  })

  test("br is Brazilian Portuguese, not Breton", () => {
    // `br` is a valid tag for the wrong language, which is why it went unnoticed:
    // it produced confident output like "19 Eost 2026".
    expect(formatDateTime(Date.UTC(2026, 7, 19, 14, 5), "br", "UTC")).toContain("ago")
    expect(formatDateTime(Date.UTC(2026, 7, 19, 14, 5), "br", "UTC")).not.toContain("Eost")
    expect(formatRelativeTime(ago(7 * HOUR), "br", NOW)).toBe("há 7 horas")
  })

  test.each(["ar", "bs", "da", "de", "en", "es", "fr", "ja", "ko", "no", "pl", "ru", "th", "zh", "zht", "br"])(
    "%s resolves to a real locale rather than falling back",
    (locale) => {
      const resolved = new Intl.RelativeTimeFormat(
        locale === "zht" ? "zh-Hant" : locale === "zh" ? "zh-Hans" : locale === "br" ? "pt-BR" : locale,
      ).resolvedOptions().locale
      expect(resolved.split("-")[0]).not.toBe("")
      // A tag Intl rejects resolves to the system default; none of ours may.
      expect(["it", "it-IT"]).not.toContain(resolved)
    },
  )
})
