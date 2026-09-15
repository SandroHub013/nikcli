import { describe, expect, test } from "bun:test"
import {
  resolvePaneState,
  STATE_FULL,
  STATE_SHORT,
  type PaneState,
} from "./pane-state"
import {
  formatCountdown,
  formatSessionQuota,
  getProviderQuota,
  type ProviderQuota,
} from "../session/quota"

describe("resolvePaneState (Proposal A 6-state resolution)", () => {
  test("resolves 'work' when status is working or provisioning", () => {
    expect(resolvePaneState({ status: "working" })).toBe("work")
    expect(resolvePaneState({ status: "provisioning" })).toBe("work")
  })

  test("resolves 'perm' when actions / interactive confirmation are pending", () => {
    expect(resolvePaneState({ status: "waiting", hasActions: true })).toBe("perm")
    expect(resolvePaneState({ status: "idle", hasActions: true })).toBe("perm")
  })

  test("resolves 'ask' when waiting on another session via ade-msg ask", () => {
    expect(resolvePaneState({ status: "waiting", activity: "ade-msg ask a «Fabio»" })).toBe("ask")
    expect(resolvePaneState({ status: "working", activity: "Attende risposta da Voice" })).toBe("ask")
  })

  test("resolves 'err' on process error or exit", () => {
    expect(resolvePaneState({ status: "error" })).toBe("err")
  })

  test("resolves 'limit' when quota is rate limited or exhausted", () => {
    const quotaView = {
      providerName: "Anthropic · Max",
      isLimit: true,
      remainingRatio: 0,
      bindingKey: "5h",
      displayValue: "0%",
      countdown: "1h 40m",
      level: "crit" as const,
      windows: [],
      tooltip: "",
    }
    expect(resolvePaneState({ status: "working", quota: quotaView })).toBe("limit")
  })

  test("resolves 'idle' when prompt is ready", () => {
    expect(resolvePaneState({ status: "idle" })).toBe("idle")
    expect(resolvePaneState({ status: "done" })).toBe("idle")
  })

  test("explicit state property takes precedence", () => {
    expect(resolvePaneState({ status: "idle", state: "work" })).toBe("work")
    expect(resolvePaneState({ status: "working", state: "limit" })).toBe("limit")
  })
})

describe("Proposal A state vocabulary", () => {
  const allStates: PaneState[] = ["work", "perm", "ask", "err", "limit", "idle"]

  test("all 6 canonical states have full and short Italian labels", () => {
    for (const st of allStates) {
      expect(STATE_FULL[st]).toBeDefined()
      expect(STATE_SHORT[st]).toBeDefined()
      expect(STATE_FULL[st].length).toBeGreaterThan(0)
      expect(STATE_SHORT[st].length).toBeGreaterThan(0)
    }
    expect(STATE_FULL.work).toBe("Al lavoro")
    expect(STATE_FULL.perm).toBe("In attesa di permesso")
    expect(STATE_FULL.ask).toBe("Attende un'altra sessione")
    expect(STATE_FULL.err).toBe("Bloccata")
    expect(STATE_FULL.limit).toBe("Limite raggiunto")
    expect(STATE_FULL.idle).toBe("Pronta")

    expect(STATE_SHORT.work).toBe("Al lavoro")
    expect(STATE_SHORT.perm).toBe("Permesso")
    expect(STATE_SHORT.ask).toBe("Attende")
    expect(STATE_SHORT.err).toBe("Bloccata")
    expect(STATE_SHORT.limit).toBe("Limite")
    expect(STATE_SHORT.idle).toBe("Pronta")
  })
})

describe("Proposal A Quota Horizon data integration", () => {
  const now = 1_000_000

  test("Claude provider quota generates binding weekly window with countdown from live quota", () => {
    const claude = getProviderQuota("claude-code", now)
    expect(claude).toBeDefined()
    expect(claude?.bindingKey).toBe("sett.")
    expect(claude?.displayValue).toMatch(/^\d+%$/)
    expect(claude?.level).toBe("ok")
    expect(claude?.countdown).toBe("21/09")
    expect(claude?.tooltip).toContain("sett.:")
    expect(claude?.tooltip).toContain("reset il 21/09")
  })

  test("Claude provider quota generates binding 5h window when 5h has lower remaining", () => {
    const quota: ProviderQuota = {
      id: "claude",
      name: "Anthropic · Max",
      status: "ok",
      metrics: [
        { label: "5h", remaining: 45, resetAt: new Date(now + 6_000_000).toISOString() },
        { label: "sett.", remaining: 71, resetAt: new Date(now + 172_800_000).toISOString() },
      ],
    }
    const view = formatSessionQuota(quota, now)
    expect(view.bindingKey).toBe("5h")
    expect(view.displayValue).toBe("45%")
    expect(view.countdown).toBe("1h 40m")
  })

  test("Rate limited Claude shows limit flag and countdown for urg styling", () => {
    const quota: ProviderQuota = {
      id: "claude",
      name: "Anthropic · Max",
      status: "rate_limited",
      metrics: [
        { label: "5h", remaining: 0, resetAt: new Date(now + 6_000_000).toISOString() },
        { label: "sett.", remaining: 44, resetAt: new Date(now + 172_800_000).toISOString() },
      ],
    }
    const view = formatSessionQuota(quota, now)
    expect(view.isLimit).toBe(true)
    expect(view.bindingKey).toBe("5h")
    expect(view.displayValue).toBe("0%")
    expect(view.level).toBe("crit")
    expect(view.countdown).toBe("1h 40m")
  })

  test("Gemini / agy provider highlights 2.5 Pro binding metric under 20% with critical level", () => {
    const agy = getProviderQuota("agy", now)
    expect(agy).toBeDefined()
    expect(agy?.bindingKey).toBe("2.5 Pro")
    expect(agy?.displayValue).toBe("12%")
    expect(agy?.level).toBe("crit")
    expect(agy?.countdown).toBe("6h 10m")
  })
})
