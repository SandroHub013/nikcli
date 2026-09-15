import { describe, expect, test } from "bun:test"
import {
  cooldownRemainingMs,
  calculateReadiness,
  backoffForProvider,
  selectBestProvider,
  parseClaudeSnapshot,
  parseAntigravitySnapshot,
  compareUsage,
  formatCountdown,
  formatSessionQuota,
  parseQuotaAxiSnapshot,
  quotaForAgent,
  readQuotaAxiSnapshot,
  isQuotaUnavailable,
  QUOTA_STALE_MS,
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

  test("multi-window: cooldown is taken only from the exhausted metric, not longer healthy ones (P1)", () => {
    const oneHour = 3_600_000
    const sevenDays = 7 * 24 * 3_600_000
    const quota: ProviderQuota = {
      id: "claude",
      name: "Claude Code",
      status: "ok",
      metrics: [
        { label: "5h", remaining: 0, resetAt: new Date(now + oneHour).toISOString() },
        { label: "7d", remaining: 50, resetAt: new Date(now + sevenDays).toISOString() },
      ],
    }
    const r = calculateReadiness(quota, now)
    expect(r.score).toBe(0.0)
    expect(r.isAvailable).toBe(false)
    expect(r.cooldownMs).toBe(oneHour)
    expect(r.resetAt).toBe(new Date(now + oneHour).toISOString())

    const plan = backoffForProvider(quota, now)
    expect(plan.mustWait).toBe(true)
    expect(plan.waitMs).toBe(oneHour + 500)
  })

  test("remaining percentage is clamped to [0, 100] and NaN safely handled (P2)", () => {
    const over100: ProviderQuota = {
      id: "claude",
      name: "Claude Code",
      status: "ok",
      metrics: [{ label: "credits", remaining: 150 }],
    }
    const r1 = calculateReadiness(over100, now)
    expect(r1.score).toBe(1.0)
    expect(r1.worstRemainingPct).toBe(100)

    const negative: ProviderQuota = {
      id: "claude",
      name: "Claude Code",
      status: "ok",
      metrics: [{ label: "credits", remaining: -20 }],
    }
    const r2 = calculateReadiness(negative, now)
    expect(r2.score).toBe(0.0)
    expect(r2.isAvailable).toBe(false)

    const nanMetric: ProviderQuota = {
      id: "claude",
      name: "Claude Code",
      status: "ok",
      metrics: [{ label: "credits", remaining: Number.NaN }],
    }
    const r3 = calculateReadiness(nanMetric, now)
    expect(r3.score).toBe(0.0)
    expect(r3.isAvailable).toBe(false)
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

describe("formatCountdown", () => {
  test("formats hours and minutes", () => {
    expect(formatCountdown(1 * 3600_000 + 40 * 60_000)).toBe("1h 40m")
  })

  test("under an hour, minutes only: the bar is redrawn every 30 s, so seconds would be wrong", () => {
    expect(formatCountdown(5 * 60_000 + 12_000)).toBe("5m")
    expect(formatCountdown(5 * 60_000 + 59_000)).toBe("5m")
  })

  test("the last minute reads <1m, and a reset already due reads 0m", () => {
    expect(formatCountdown(45_000)).toBe("<1m")
    expect(formatCountdown(0)).toBe("0m")
    expect(formatCountdown(-5000)).toBe("0m")
  })
})

describe("formatSessionQuota", () => {
  const now = 1_000_000

  test("formats provider quota with binding window, level and countdown", () => {
    const quota: ProviderQuota = {
      id: "claude",
      name: "Anthropic · Max",
      status: "ok",
      metrics: [
        { label: "5h", remaining: 62, resetAt: new Date(now + 6_000_000).toISOString() }, // 1h 40m
        { label: "sett.", remaining: 71, resetAt: new Date(now + 172_800_000).toISOString() },
      ],
    }
    const view = formatSessionQuota(quota, now)
    expect(view.bindingKey).toBe("5h")
    expect(view.remainingRatio).toBe(0.62)
    expect(view.displayValue).toBe("62%")
    expect(view.level).toBe("ok")
    expect(view.countdown).toBe("1h 40m")
    expect(view.tooltip).toContain("Quota Anthropic · Max")
    expect(view.tooltip).toContain("5h: 62% rimasto")
  })

  test("flags critical level when remaining ratio is below 20%", () => {
    const quota: ProviderQuota = {
      id: "agy",
      name: "Google · Gemini",
      status: "ok",
      metrics: [
        { label: "2.5 Pro", remaining: 12, resetAt: new Date(now + 22_200_000).toISOString() },
        { label: "Flash", remaining: 90 },
      ],
    }
    const view = formatSessionQuota(quota, now)
    expect(view.bindingKey).toBe("2.5 Pro")
    expect(view.remainingRatio).toBe(0.12)
    expect(view.level).toBe("crit")
  })
})

describe("parseQuotaAxiSnapshot", () => {
  test("correctly parses quota-axi json format for claude and codex", () => {
    const raw = {
      generatedAt: "2026-09-15T18:45:14.212Z",
      schemaVersion: 1,
      providers: [
        {
          provider: "claude",
          label: "Claude",
          plan: "max",
          windows: [
            { id: "five_hour", label: "session", kind: "session", percentUsed: 21, percentRemaining: 79, resetsAt: "2026-09-15T22:40:00Z" },
            { id: "seven_day", label: "week", kind: "weekly", percentUsed: 41, percentRemaining: 59, resetsAt: "2026-09-21T13:00:00Z" },
          ],
        },
        {
          provider: "codex",
          label: "Codex",
          plan: "free",
          windows: [
            { id: "window:720h", label: "720h window", kind: "unknown", percentUsed: 100, percentRemaining: 0, resetsAt: "2026-10-13T13:12:12Z" },
          ],
        },
      ],
    }
    const parsed = parseQuotaAxiSnapshot(raw)
    expect(parsed.length).toBe(2)

    const claude = parsed.find((p) => p.id === "claude")
    expect(claude).toBeDefined()
    expect(claude?.name).toBe("Anthropic · Max")
    // The plan the report states, not an upgrade: "free" stays Free.
    expect(parsed.find((p) => p.id === "codex")?.name).toBe("OpenAI · Free")
    expect(claude?.metrics.find((m) => m.label === "5h")?.remaining).toBe(79)
    expect(claude?.metrics.find((m) => m.label === "sett.")?.remaining).toBe(59)

    const view = formatSessionQuota(claude!, Date.parse("2026-09-15T19:00:00Z"))
    expect(view.bindingKey).toBe("sett.")
    expect(view.displayValue).toBe("59%")
    expect(view.countdown).toBe("21/09")

    const codex = parsed.find((p) => p.id === "codex")
    expect(codex).toBeDefined()
    expect(codex?.status).toBe("rate_limited")
  })
})

describe("quotaForAgent: a real reading or n/d, never a made-up figure", () => {
  const written = Date.parse("2026-09-15T19:45:00Z")
  const report = {
    generatedAt: new Date(written).toISOString(),
    providers: [
      {
        provider: "claude",
        plan: "max",
        windows: [
          { id: "five_hour", kind: "session", percentRemaining: 64, resetsAt: "2026-09-15T22:40:00Z" },
          { id: "seven_day", kind: "weekly", percentRemaining: 57, resetsAt: "2026-09-21T13:00:00Z" },
        ],
        state: { stale: false },
      },
      { provider: "codex", plan: "free", windows: [{ id: "window:720h", percentRemaining: 0, resetsAt: "2026-10-13T13:12:12Z" }] },
      { provider: "cursor", windows: [{ id: "included_usage", percentRemaining: 97 }] },
    ],
  }
  const snapshot = readQuotaAxiSnapshot(report)
  const soon = written + 60_000

  test("Claude and Codex show what quota-axi reported", () => {
    const claude = quotaForAgent("claude-code", snapshot, soon)
    expect(isQuotaUnavailable(claude)).toBe(false)
    if (!claude || isQuotaUnavailable(claude)) throw new Error("unreachable")
    expect(claude.bindingKey).toBe("sett.")
    expect(claude.displayValue).toBe("57%")
    expect(claude.tooltip).toContain("Letto da quota-axi")

    const codex = quotaForAgent("codex", snapshot, soon)
    if (!codex || isQuotaUnavailable(codex)) throw new Error("expected a reading")
    expect(codex.isLimit).toBe(true)
  })

  test("agy and nikcli are n/d even when the report mentions other providers", () => {
    expect(isQuotaUnavailable(quotaForAgent("agy", snapshot, soon))).toBe(true)
    expect(isQuotaUnavailable(quotaForAgent("nikcli", snapshot, soon))).toBe(true)
  })

  test("no report, an old report, or a stale provider is n/d", () => {
    expect(isQuotaUnavailable(quotaForAgent("claude-code", undefined, soon))).toBe(true)
    expect(isQuotaUnavailable(quotaForAgent("claude-code", snapshot, written + QUOTA_STALE_MS + 1))).toBe(true)
    const stale = readQuotaAxiSnapshot({
      ...report,
      providers: [{ ...report.providers[0], state: { stale: true } }],
    })
    expect(isQuotaUnavailable(quotaForAgent("claude-code", stale, soon))).toBe(true)
    const undated = readQuotaAxiSnapshot({ providers: report.providers })
    expect(isQuotaUnavailable(quotaForAgent("claude-code", undated, soon))).toBe(true)
  })

  test("a provider with no windows is n/d, not 100%", () => {
    const empty = readQuotaAxiSnapshot({ generatedAt: report.generatedAt, providers: [{ provider: "claude", windows: [] }] })
    expect(isQuotaUnavailable(quotaForAgent("claude-code", empty, soon))).toBe(true)
  })

  test("an agent ADE has no quota notion for shows nothing", () => {
    expect(quotaForAgent("terminal", snapshot, soon)).toBeUndefined()
    expect(quotaForAgent(undefined, snapshot, soon)).toBeUndefined()
  })
})

describe("which agents count as Codex", () => {
  test("o1, o3 and o4 as model names do, as parts of other words they do not", () => {
    for (const agent of ["o3", "o3-mini", "openai/o1", "o4-mini-high"]) {
      expect(quotaForAgent(agent, undefined, 0)?.providerName).toBe("OpenAI")
    }
    for (const agent of ["pro1", "demo3", "video1", "photo3-bot"]) {
      expect(quotaForAgent(agent, undefined, 0)).toBeUndefined()
    }
  })
})
