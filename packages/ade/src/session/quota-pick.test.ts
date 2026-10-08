import { afterEach, describe, expect, test } from "bun:test"
import { pickProvider, setProviderPicker } from "./provider-pick"
import { readQuotaAxiSnapshot } from "./quota"
import { pickByQuota } from "./quota-pick"

const written = Date.parse("2026-09-15T20:00:00Z")
const now = written + 60_000

const claude = (remaining: number) => ({
  provider: "claude",
  plan: "max",
  windows: [
    { id: "five_hour", kind: "session", percentRemaining: remaining, resetsAt: "2026-09-15T22:40:00Z" },
    { id: "seven_day", kind: "weekly", percentRemaining: Math.max(remaining, 40), resetsAt: "2026-09-21T13:00:00Z" },
  ],
})
const codex = (remaining: number) => ({
  provider: "codex",
  plan: "free",
  windows: [{ id: "window:720h", percentRemaining: remaining, resetsAt: "2026-10-13T13:12:12Z" }],
})
const report = (...providers: object[]) =>
  readQuotaAxiSnapshot({ generatedAt: new Date(written).toISOString(), providers })

afterEach(() => setProviderPicker())

describe("pickByQuota", () => {
  test("an old Limite does not reroute: the window may have reset since", () => {
    const old = report(claude(0), codex(80))
    expect(pickByQuota({ agent: "claude-code", from: "m" }, old, written + 31 * 60_000)).toEqual({
      agent: "claude-code",
    })
  })

  // Full review 2026-10-06, sessions 8: the reading is fresh, but the window it describes has reset.
  test("a window that reset after a fresh reading does not reroute the spawn", () => {
    const fresh = readQuotaAxiSnapshot({
      generatedAt: "2026-09-15T22:30:00Z",
      providers: [claude(0), codex(80)],
    })
    // 22:40 was the five-hour reset; at 22:45 the reading is 15 minutes old, so it is not stale.
    const afterReset = Date.parse("2026-09-15T22:45:00Z")
    expect(pickByQuota({ agent: "claude-code", from: "m" }, fresh, afterReset)).toEqual({ agent: "claude-code" })
    // Before the reset it does reroute: the test would pass for the wrong reason otherwise.
    const beforeReset = Date.parse("2026-09-15T22:35:00Z")
    expect(pickByQuota({ agent: "claude-code", from: "m" }, fresh, beforeReset).agent).toBe("codex")
  })

  test("an agent with quota left is started as asked, with nothing to explain", () => {
    expect(pickByQuota({ agent: "claude-code", from: "m" }, report(claude(60), codex(0)), now)).toEqual({
      agent: "claude-code",
    })
  })

  test("an agent in Limite is replaced by one with quota, and the receipt says why", () => {
    const picked = pickByQuota({ agent: "codex", from: "m" }, report(claude(60), codex(0)), now)
    expect(picked.agent).toBe("claude-code")
    expect(picked.reason).toContain("quota OpenAI · Free esaurita")
    expect(picked.reason).toContain("fino al 13/10")
    expect(picked.reason).toContain("scelto claude-code")
    expect(picked.reason).toContain("60% rimasto")
  })

  test("Codex is never the replacement while it is spent", () => {
    const picked = pickByQuota({ agent: "claude-code", from: "m" }, report(claude(0), codex(0)), now)
    expect(picked.agent).toBe("claude-code")
    expect(picked.reason).toContain("nessun altro agente ha quota disponibile")
  })

  test("Codex is a replacement again once its report shows quota", () => {
    const picked = pickByQuota({ agent: "claude-code", from: "m" }, report(claude(0), codex(35)), now)
    expect(picked.agent).toBe("codex")
  })

  test("an agent whose quota is n/d is started as asked: no evidence, no reroute", () => {
    expect(pickByQuota({ agent: "agy", from: "m" }, report(claude(60)), now)).toEqual({ agent: "agy" })
    expect(pickByQuota({ agent: "ragu", from: "m" }, report(claude(60)), now)).toEqual({ agent: "ragu" })
    expect(pickByQuota({ agent: "codex", from: "m" }, undefined, now)).toEqual({ agent: "codex" })
  })

  test("a report too old to trust decides nothing", () => {
    const old = written + 31 * 60_000
    expect(pickByQuota({ agent: "codex", from: "m" }, report(claude(60), codex(0)), old)).toEqual({ agent: "codex" })
  })

  test("n/d agents are never picked as the replacement", () => {
    const picked = pickByQuota({ agent: "codex", from: "m" }, report(codex(0)), now, ["agy", "ragu", "claude-code"])
    expect(picked.agent).toBe("codex")
    expect(picked.reason).toContain("nessun altro agente")
  })

  test("the best replacement is the one with the most quota left", () => {
    const picked = pickByQuota({ agent: "claude-code", from: "m" }, report(claude(0), codex(80)), now, [
      "claude-code",
      "codex",
    ])
    expect(picked.agent).toBe("codex")
  })
})

describe("registered as the spawn picker", () => {
  test("pickProvider answers with the quota rule", async () => {
    const snapshot = report(claude(60), codex(0))
    setProviderPicker((input) => pickByQuota(input, snapshot, now))
    expect((await pickProvider({ agent: "codex", from: "m" })).agent).toBe("claude-code")
    expect(await pickProvider({ agent: "claude-code", from: "m" })).toEqual({ agent: "claude-code" })
  })
})
