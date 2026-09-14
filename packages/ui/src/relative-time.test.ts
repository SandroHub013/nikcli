import { afterEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { __resetClockForTests, relativeTime, useNow } from "./relative-time"

const NOW = 1_700_000_000_000
const ago = (seconds: number) => NOW - seconds * 1000

/**
 * The clock is module state shared by every caller, so the thing worth asserting
 * is not the value it reports but that exactly one interval backs all of them and
 * that it is released — a leaked interval keeps the whole app awake.
 */
function countTimers() {
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  const counters = {
    started: 0,
    cleared: 0,
    restore() {
      globalThis.setInterval = realSet
      globalThis.clearInterval = realClear
    },
  }
  globalThis.setInterval = ((handler: TimerHandler, timeout?: number) => {
    counters.started += 1
    return realSet(handler, timeout)
  }) as typeof globalThis.setInterval
  globalThis.clearInterval = ((id?: number) => {
    counters.cleared += 1
    return realClear(id)
  }) as typeof globalThis.clearInterval
  return counters
}

describe("relativeTime", () => {
  test("has nothing to say without a timestamp", () => {
    expect(relativeTime(undefined, NOW)).toBeUndefined()
    // 0 is the epoch, which every caller here means as "never".
    expect(relativeTime(0, NOW)).toBeUndefined()
  })

  test("never counts backwards when a clock skews ahead of the timestamp", () => {
    // This holds because every negative value is below the first threshold, not
    // because of the clamp in the implementation — removing the clamp keeps this
    // green. Asserted anyway: it is the behaviour callers depend on.
    expect(relativeTime(NOW + 60_000, NOW)).toBe("now")
    expect(relativeTime(NOW + 86_400_000, NOW)).toBe("now")
  })

  test.each([
    [0, "now"],
    [59, "now"],
    [60, "1m"],
    [59 * 60, "59m"],
    [60 * 60, "1h"],
    [23 * 3600, "23h"],
    [24 * 3600, "1d"],
    [6 * 86400, "6d"],
    [7 * 86400, "1w"],
    [70 * 86400, "10w"],
  ])("%i seconds ago reads %s", (seconds, expected) => {
    expect(relativeTime(ago(seconds), NOW, "en")).toBe(expected)
  })

  test("each unit hands over exactly at its boundary, with no gap", () => {
    for (const [under, boundary] of [
      [59, 60],
      [3599, 3600],
      [86399, 86400],
      [604799, 604800],
    ]) {
      expect(relativeTime(ago(under!), NOW, "en")).not.toBe(relativeTime(ago(boundary!), NOW, "en"))
    }
  })

  test("speaks the caller's language, in the dense form", () => {
    // The reason this module exists separately: a full phrase does not fit a row
    // beside a title. `Intl` produces the dense form per locale, which is not
    // always two characters — and that is the correct label for those locales.
    expect(relativeTime(ago(3 * 86400), NOW, "it")).toBe("3gg")
    expect(relativeTime(ago(3 * 86400), NOW, "fr")).toBe("3j")
    expect(relativeTime(ago(7 * 3600), NOW, "zh-Hans")).toBe("7小时")
  })

  test("says 'now' in the caller's language too", () => {
    expect(relativeTime(ago(5), NOW, "it")).toBe("ora")
    expect(relativeTime(ago(5), NOW, "fr")).toBe("maintenant")
  })

  test("defaults to English rather than to the machine's locale", () => {
    // Falling back to the system locale would make a row read differently on two
    // machines showing the same session.
    expect(relativeTime(ago(3 * 86400), NOW)).toBe("3d")
  })

  test("an unknown locale falls back rather than throwing", () => {
    expect(() => relativeTime(ago(3600), NOW, "zz")).not.toThrow()
  })
})

describe("useNow", () => {
  afterEach(() => {
    __resetClockForTests()
  })

  test("hands every subscriber the same accessor, so one tick updates them all", () => {
    createRoot((dispose) => {
      expect(useNow()).toBe(useNow())
      dispose()
    })
  })

  test("runs one interval for many subscribers rather than one each", () => {
    const timers = countTimers()
    createRoot((dispose) => {
      useNow()
      useNow()
      useNow()
      expect(timers.started).toBe(1)
      dispose()
    })
  })

  test("stops the interval once the last subscriber is disposed", () => {
    const timers = countTimers()
    const disposers: Array<() => void> = []
    createRoot((dispose) => {
      useNow()
      disposers.push(dispose)
    })
    createRoot((dispose) => {
      useNow()
      disposers.push(dispose)
    })

    disposers[0]!()
    // The second subscriber is still watching: stopping here would freeze its label.
    expect(timers.cleared).toBe(0)

    disposers[1]!()
    expect(timers.cleared).toBe(1)
  })

  test("starts a fresh interval after everyone has gone and someone returns", () => {
    const timers = countTimers()
    createRoot((dispose) => {
      useNow()
      dispose()
    })
    createRoot((dispose) => {
      useNow()
      dispose()
    })
    expect(timers.started).toBe(2)
    expect(timers.cleared).toBe(2)
  })

  test("re-reads the wall clock when it restarts, rather than serving a stale value", () => {
    const timers = countTimers()
    let first = 0
    createRoot((dispose) => {
      first = useNow()()
      dispose()
    })
    timers.restore()

    // Nothing ticked in between, so only the restart can move it forward.
    const later = first + 10 * 60_000
    const realNow = Date.now
    Date.now = () => later
    try {
      createRoot((dispose) => {
        expect(useNow()()).toBe(later)
        dispose()
      })
    } finally {
      Date.now = realNow
    }
  })
})