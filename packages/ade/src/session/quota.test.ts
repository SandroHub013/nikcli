import { describe, expect, test } from "bun:test"
import {
  cooldownRemainingMs,
  calculateReadiness,
  backoffForProvider,
  selectBestProvider,
  parseClaudeSnapshot,
  parseAntigravitySnapshot,
  compareUsage,
  type ProviderQuota,
} from "./quota"
import type { TokenUsage } from "./shared"

describe("cooldownRemainingMs", () => {
  test("returns 0 if resetAt is missing or invalid", () => {
    expect(cooldownRemainingMs({ label: "test" }, 1000)).toBe(0)
    expect(cooldownRemainingMs({ label: "test", resetAt: "invalid-date" }, 1000)).toBe(0)
  })

  test("returns 0 if resetAt is in the past", () => {
    const now = 1_000_000
    const past = new Date(now - 5000).toISOString()
    expect(cooldownRemainingMs({ label: "test", resetAt: past }, now)).toBe(0)
  })

  test("returns remaining milliseconds if resetAt is in the future", () => {
    const now = 1_000_000
    const future = new Date(now + 12_000).toISOString()
    expect(cooldownRemainingMs({ label: "test", resetAt: future }, now)).toBe(12_000)
  })
})

describe("calculateReadiness", () => {
  const now = 1_000_000

  test("rate_limited status returns score 0.0 and calculates cooldown", () => {
    const quota: ProviderQuota = {
      id: "claude",
      name: "Claude Code",
      status: "rate_limited",
      metrics: [
        { label: "5h", used: 100, remaining: 0, resetAt: new Date(now + 30_000).toISOString() },
      ],
    }
    const r = calculateReadiness(quota, now)
    expect(r.score).toBe(0.0)
    expect(r.isAvailable).toBe(false)
    expect(r.cooldownMs).toBe(30_000)
    expect(r.resetAt).toBeDefined()
  })

  test("unauthenticated or error status returns score 0.0", () => {
    const quota: ProviderQuota = {
      id: "codex",
      name: "Codex",
      status: "unauthenticated",
      metrics: [],
      message: "login richiesto",
    }
    const r = calculateReadiness(quota, now)
    expect(r.score).toBe(0.0)
    expect(r.isAvailable).toBe(false)
    expect(r.reason).toContain("login richiesto")
  })

  test("healthy quota returns score proportional to lowest remaining metric", () => {
    const quota: ProviderQuota = {
      id: "claude",
      name: "Claude Code",
      status: "ok",
      metrics: [
        { label: "5h", remaining: 40 },
        { label: "7d", remaining: 85 },
      ],
    }
    const r = calculateReadiness(quota, now)
    expect(r.score).toBe(0.4)
    expect(r.isAvailable).toBe(true)
    expect(r.worstRemainingPct).toBe(40)
  })

  test("metric with 0 remaining makes provider unavailable", () => {
    const quota: ProviderQuota = {
      id: "claude",
      name: "Claude Code",
      status: "ok",
      metrics: [{ label: "5h", remaining: 0, resetAt: new Date(now + 10_000).toISOString() }],
    }
    const r = calculateReadiness(quota, now)
    expect(r.score).toBe(0.0)
    expect(r.isAvailable).toBe(false)
    expect(r.cooldownMs).toBe(10_000)
  })

  test("nominal availability when no metric limits are given", () => {
    const quota: ProviderQuota = {
      id: "agy",
      name: "Antigravity",
      status: "ok",
      metrics: [],
    }
    const r = calculateReadiness(quota, now)
    expect(r.score).toBe(1.0)
    expect(r.isAvailable).toBe(true)
  })
})

describe("backoffForProvider", () => {
  const now = 1_000_000

  test("available provider requires no wait", () => {
    const quota: ProviderQuota = {
      id: "codex",
      name: "Codex",
      status: "ok",
      metrics: [{ label: "limit", remaining: 80 }],
    }
    const plan = backoffForProvider(quota, now)
    expect(plan.mustWait).toBe(false)
    expect(plan.waitMs).toBe(0)
  })

  test("rate limited provider with resetAt gets deterministic wait with safety margin", () => {
    const future = new Date(now + 5_000).toISOString()
    const quota: ProviderQuota = {
      id: "claude",
      name: "Claude Code",
      status: "rate_limited",
      metrics: [{ label: "5h", remaining: 0, resetAt: future }],
    }
    const plan = backoffForProvider(quota, now)
    expect(plan.mustWait).toBe(true)
    // 5000ms + 500ms margin = 5500ms
    expect(plan.waitMs).toBe(5500)
    expect(plan.resetAt).toBe(future)
  })
})

describe("selectBestProvider", () => {
  const now = 1_000_000
  const quotas: Record<string, ProviderQuota> = {
    claude: {
      id: "claude",
      name: "Claude Code",
      status: "ok",
      metrics: [{ label: "5h", remaining: 15 }], // 15% residuo
    },
    codex: {
      id: "codex",
      name: "Codex",
      status: "rate_limited",
      metrics: [{ label: "limit", remaining: 0, resetAt: new Date(now + 60_000).toISOString() }],
    },
    gemini: {
      id: "gemini",
      name: "Gemini",
      status: "ok",
      metrics: [{ label: "pro", remaining: 90 }], // 90% residuo
    },
  }

  test("picks provider with highest readiness score", () => {
    const choice = selectBestProvider(["claude", "codex", "gemini"], quotas, now)
    expect(choice.chosen).toBe("gemini")
    expect(choice.readiness?.score).toBe(0.9)
  })

  test("skips rate limited providers even if listed first", () => {
    const choice = selectBestProvider(["codex", "claude"], quotas, now)
    expect(choice.chosen).toBe("claude")
    expect(choice.readiness?.score).toBe(0.15)
  })

  test("fails gracefully when all candidates are blocked", () => {
    const choice = selectBestProvider(["codex"], quotas, now)
    expect(choice.chosen).toBeUndefined()
    expect(choice.reason).toContain("non disponibili")
  })
})

describe("parseClaudeSnapshot", () => {
  test("parses live snapshot from official-bridge", () => {
    const raw = {
      version: 1,
      provider: "claude",
      capturedAt: "2026-09-15T12:00:00.000Z",
      data: {
        rateLimits: {
          five_hour: { used_percentage: 23.4, resets_at: "2026-09-15T15:00:00.000Z" },
          seven_day: { used_percentage: 12.0, resets_at: "2026-09-22T00:00:00.000Z" },
        },
      },
    }
    const quota = parseClaudeSnapshot(raw)
    expect(quota.status).toBe("ok")
    expect(quota.metrics).toHaveLength(2)
    expect(quota.metrics[0].label).toBe("Finestra 5h")
    expect(quota.metrics[0].used).toBe(23)
    expect(quota.metrics[0].remaining).toBe(77)
    expect(quota.metrics[0].resetAt).toBe("2026-09-15T15:00:00.000Z")
  })

  test("detects 100% usage as rate_limited", () => {
    const raw = {
      version: 1,
      provider: "claude",
      data: {
        rateLimits: {
          five_hour: { used_percentage: 100, resets_at: "2026-09-15T16:00:00.000Z" },
        },
      },
    }
    const quota = parseClaudeSnapshot(raw)
    expect(quota.status).toBe("rate_limited")
    expect(quota.metrics[0].remaining).toBe(0)
  })
})

describe("parseAntigravitySnapshot", () => {
  test("parses Gemini buckets from statusLine bridge", () => {
    const raw = {
      version: 1,
      provider: "antigravity",
      capturedAt: "2026-09-15T12:00:00.000Z",
      data: {
        planTier: "Ultra",
        quota: {
          "gemini-2.5-pro": { remaining_fraction: 0.85, reset_time: "2026-09-15T18:00:00.000Z" },
          "gemini-2.5-flash": { remaining_fraction: 1.0 },
        },
      },
    }
    const quota = parseAntigravitySnapshot(raw)
    expect(quota.status).toBe("ok")
    expect(quota.plan).toBe("Ultra")
    expect(quota.metrics).toHaveLength(2)
    const pro = quota.metrics.find((m) => m.label === "gemini-2.5-pro")
    expect(pro?.remaining).toBe(85)
    expect(pro?.resetAt).toBe("2026-09-15T18:00:00.000Z")
  })
})

describe("compareUsage", () => {
  test("identifies perfect match between ledger and transcript", () => {
    const a: TokenUsage = { input: 100, cacheRead: 50, cacheWrite: 20, output: 30, requests: 2 }
    const b: TokenUsage = { input: 100, cacheRead: 50, cacheWrite: 20, output: 30, requests: 2 }
    const res = compareUsage(a, b)
    expect(res.match).toBe(true)
    expect(res.totalDiff).toBe(0)
  })

  test("calculates deltas when there is variance", () => {
    const ledger: TokenUsage = { input: 120, cacheRead: 80, cacheWrite: 10, output: 40, requests: 3 }
    const transcript: TokenUsage = { input: 100, cacheRead: 50, cacheWrite: 10, output: 30, requests: 2 }
    const res = compareUsage(ledger, transcript)
    expect(res.match).toBe(false)
    expect(res.inputDiff).toBe(20)
    expect(res.cacheReadDiff).toBe(30)
    expect(res.outputDiff).toBe(10)
    expect(res.totalDiff).toBe(30)
  })
})
