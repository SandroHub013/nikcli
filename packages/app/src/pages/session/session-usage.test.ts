import { describe, expect, test } from "bun:test"
import { formatCost, formatTokens, sessionUsage, type UsageMessage } from "./session-usage"

const assistant = (over: Partial<UsageMessage> = {}): UsageMessage => ({
  role: "assistant",
  cost: 0.01,
  tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 1000, write: 20 } },
  ...over,
})

describe("sessionUsage", () => {
  test("an empty session has used nothing", () => {
    const usage = sessionUsage([])
    expect(usage.turns).toBe(0)
    expect(usage.billable).toBe(0)
    expect(usage.cost).toBe(0)
  })

  test("sums across assistant turns", () => {
    const usage = sessionUsage([assistant(), assistant()])
    expect(usage.turns).toBe(2)
    expect(usage.input).toBe(200)
    expect(usage.output).toBe(100)
    expect(usage.reasoning).toBe(20)
    expect(usage.cost).toBeCloseTo(0.02, 5)
  })

  test("billable excludes the cache, which would dwarf it", () => {
    // 1000 cache reads against 160 real tokens: including them would make the
    // number meaningless as a measure of what the turn cost.
    const usage = sessionUsage([assistant()])
    expect(usage.billable).toBe(160)
    expect(usage.cacheRead).toBe(1000)
  })

  test("ignores user messages", () => {
    const user: UsageMessage = { role: "user", cost: 99, tokens: { input: 99 } }
    expect(sessionUsage([user, assistant()]).turns).toBe(1)
    expect(sessionUsage([user]).cost).toBe(0)
  })

  test("does not count a turn that has not reported usage yet", () => {
    // The shape the server actually creates: a zeroed `tokens` object, not an
    // absent one. Testing `{ role: "assistant" }` certified a message the server
    // never emits, and the guard that checked `!tokens` never fired in
    // production — the badge read `0 · $0.00` for the whole of every turn.
    const streaming: UsageMessage = {
      role: "assistant",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    expect(sessionUsage([streaming]).turns).toBe(0)
    expect(sessionUsage([streaming, assistant()]).turns).toBe(1)
  })

  test("counts a turn the moment it reports anything at all", () => {
    const first = { role: "assistant", cost: 0, tokens: { input: 12, output: 0, reasoning: 0 } }
    expect(sessionUsage([first]).turns).toBe(1)
    expect(sessionUsage([first]).billable).toBe(12)
  })

  test("cache traffic alone is not a turn: it is charged to nothing yet", () => {
    const cacheOnly = { role: "assistant", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 900, write: 0 } } }
    expect(sessionUsage([cacheOnly]).turns).toBe(0)
  })

  test("counts a turn that reported a cost but no breakdown", () => {
    expect(sessionUsage([{ role: "assistant", cost: 0.5 }]).turns).toBe(1)
  })

  test("survives a message missing every field it might have", () => {
    // Nothing to report is nothing to count — the same rule as a streaming turn.
    const bare: UsageMessage = { role: "assistant", tokens: {} }
    const usage = sessionUsage([bare])
    expect(usage.turns).toBe(0)
    expect(usage.billable).toBe(0)
    expect(usage.cost).toBe(0)
  })

  test("a turn with no tokens but a real cost still counts", () => {
    // Some providers bill without reporting a breakdown; the money is the proof
    // the turn happened.
    expect(sessionUsage([{ role: "assistant", cost: 0.004, tokens: {} }]).turns).toBe(1)
  })
})

describe("formatTokens", () => {
  test.each([
    [0, "0"],
    [1, "1"],
    [999, "999"],
    [1000, "1k"],
    [1500, "1.5k"],
    [12_345, "12.3k"],
    [999_999, "999.9k"],
    [1_000_000, "1M"],
    [2_540_000, "2.5M"],
  ])("%i reads %p", (count, expected) => {
    expect(formatTokens(count)).toBe(expected)
  })

  test("rounds down, never up", () => {
    // 999 tokens is not "1k": this is a running total, and overstating what has
    // been spent is the wrong direction to be wrong in.
    expect(formatTokens(999)).toBe("999")
    expect(formatTokens(1999)).toBe("1.9k")
    expect(formatTokens(1_999_999)).toBe("1.9M")
  })

  test("never shows a negative or a fraction of a token", () => {
    expect(formatTokens(-5)).toBe("0")
    expect(formatTokens(12.7)).toBe("12")
  })
})

describe("formatCost", () => {
  test("shows cents for an ordinary amount", () => {
    expect(formatCost(1.5, "en-US")).toBe("$1.50")
  })

  test("shows more digits when rounding would print zero", () => {
    // "$0.00" for a real charge reads as free.
    expect(formatCost(0.0023, "en-US")).toBe("$0.0023")
  })

  test("free is free", () => {
    expect(formatCost(0, "en-US")).toBe("$0.00")
  })

  test("follows the locale's conventions", () => {
    expect(formatCost(1.5, "de-DE")).not.toBe(formatCost(1.5, "en-US"))
  })
})
