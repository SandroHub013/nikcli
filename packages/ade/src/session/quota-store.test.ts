import { describe, expect, test } from "bun:test"
import { createRoot, createMemo } from "solid-js"
import { quotaForAgent, isQuotaUnavailable } from "./quota"
import { createQuotaStore } from "./quota-store"

const report = (remaining: number, at: string) =>
  JSON.stringify({
    generatedAt: at,
    providers: [{ provider: "claude", plan: "max", windows: [{ id: "five_hour", kind: "session", percentRemaining: remaining, resetsAt: "2026-09-15T22:40:00Z" }] }],
  })

describe("createQuotaStore", () => {
  test("a view built before the first read updates when the report arrives, and again when it changes", async () => {
    let clock = Date.parse("2026-09-15T20:00:00Z")
    let text: string | undefined
    const store = createQuotaStore(async () => text, () => clock)

    const seen = createRoot(() => createMemo(() => quotaForAgent("claude-code", store.snapshot(), store.now())))
    expect(isQuotaUnavailable(seen())).toBe(true)

    text = report(64, "2026-09-15T19:59:00Z")
    await store.refresh()
    const first = seen()
    if (!first || isQuotaUnavailable(first)) throw new Error("expected a reading")
    expect(first.displayValue).toBe("64%")

    text = report(51, "2026-09-15T20:04:00Z")
    clock = Date.parse("2026-09-15T20:05:00Z")
    await store.refresh()
    const second = seen()
    if (!second || isQuotaUnavailable(second)) throw new Error("expected a reading")
    expect(second.displayValue).toBe("51%")
  })

  test("the clock moves on each refresh, so the countdown does", async () => {
    let clock = Date.parse("2026-09-15T20:00:00Z")
    const text = report(64, "2026-09-15T19:59:00Z")
    const store = createQuotaStore(async () => text, () => clock)
    await store.refresh()
    const before = quotaForAgent("claude-code", store.snapshot(), store.now())
    clock += 10 * 60_000
    await store.refresh()
    const after = quotaForAgent("claude-code", store.snapshot(), store.now())
    if (!before || !after || isQuotaUnavailable(before) || isQuotaUnavailable(after)) throw new Error("expected readings")
    expect(before.countdown).toBe("2h 40m")
    expect(after.countdown).toBe("2h 30m")
  })

  test("a failed read, a half-written file or no file leaves no figure behind", async () => {
    const clock = () => Date.parse("2026-09-15T20:00:00Z")
    let mode: "good" | "broken" | "throws" | "none" = "good"
    const store = createQuotaStore(async () => {
      if (mode === "throws") throw new Error("EPERM")
      if (mode === "broken") return "{\"generatedAt\": \"2026-09"
      if (mode === "none") return undefined
      return report(64, "2026-09-15T19:59:00Z")
    }, clock)

    for (const next of ["broken", "throws", "none"] as const) {
      mode = "good"
      await store.refresh()
      expect(isQuotaUnavailable(quotaForAgent("claude-code", store.snapshot(), store.now()))).toBe(false)
      mode = next
      await store.refresh()
      expect(isQuotaUnavailable(quotaForAgent("claude-code", store.snapshot(), store.now()))).toBe(true)
    }
  })
})
