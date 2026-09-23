import { describe, expect, it } from "bun:test"
import { VizCatalog } from "@nikcli-ai/util/viz"
import type { AggregatedStats, DayStats } from "@tui/util/analytics-aggregator"
import { buildCommandCenterSpec, latticeFromSync } from "@tui/util/command-center"

function day(date: string, fields: Partial<DayStats> = {}): DayStats {
  return {
    date,
    sessions: 0,
    tokens: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    messages: 0,
    models: new Map(),
    ...fields,
  }
}

function emptyStats(): AggregatedStats {
  return {
    global: {
      sessions: 0,
      archivedSessions: 0,
      messages: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      projects: [],
      workspaces: { total: 0, active: 0, disconnected: 0, byType: {} },
      backgroundRuns: {
        total: 0,
        running: 0,
        completed: 0,
        error: 0,
        cancelled: 0,
        successRate: 0,
        avgDuration: 0,
        topAgents: [],
      },
      toolUsage: { total: 0, tools: [], mostUsed: [] },
      todos: {
        total: 0,
        pending: 0,
        inProgress: 0,
        completed: 0,
        cancelled: 0,
        completionRate: 0,
        byPriority: [],
      },
      efficiency: {
        costPer1kTokens: 0,
        costPerSession: 0,
        avgTokensPerSession: 0,
        avgCostPerDay: 0,
      },
    },
    projects: [],
    workspaces: { total: 0, active: 0, disconnected: 0, byType: {} },
    sessions: [],
    providers: new Map(),
    models: [],
    days: [],
    backgroundRuns: {
      total: 0,
      running: 0,
      completed: 0,
      error: 0,
      cancelled: 0,
      successRate: 0,
      avgDuration: 0,
      topAgents: [],
    },
    toolUsage: { total: 0, tools: [], mostUsed: [] },
    todos: {
      total: 0,
      pending: 0,
      inProgress: 0,
      completed: 0,
      cancelled: 0,
      completionRate: 0,
      byPriority: [],
    },
  }
}

function makeStats(): AggregatedStats {
  const stats = emptyStats()
  stats.global = {
    ...stats.global,
    sessions: 12,
    archivedSessions: 3,
    messages: 240,
    tokens: {
      input: 100_000,
      output: 50_000,
      reasoning: 10_000,
      cacheRead: 25_000,
      cacheWrite: 5_000,
    },
    cost: 4.2,
    workspaces: { total: 2, active: 1, disconnected: 1, byType: { git: 2 } },
    backgroundRuns: {
      total: 6,
      running: 1,
      completed: 4,
      error: 1,
      cancelled: 0,
      successRate: 80,
      avgDuration: 12_000,
      topAgents: [],
    },
    toolUsage: {
      total: 100,
      tools: [
        { name: "bash", count: 60, successRate: 95 },
        { name: "read", count: 40, successRate: 50 },
      ],
      mostUsed: [],
    },
    todos: {
      total: 10,
      pending: 2,
      inProgress: 1,
      completed: 7,
      cancelled: 0,
      completionRate: 70,
      byPriority: [],
    },
    efficiency: {
      costPer1kTokens: 0.0263,
      costPerSession: 0.35,
      avgTokensPerSession: 13333,
      avgCostPerDay: 0.21,
    },
  }
  stats.workspaces = stats.global.workspaces
  stats.backgroundRuns = stats.global.backgroundRuns
  stats.toolUsage = stats.global.toolUsage
  stats.todos = stats.global.todos
  stats.sessions = [
    {
      sessionID: "s1",
      title: "Tune the renderer",
      directory: "/tmp",
      messages: 12,
      tokens: { input: 1000, output: 500, reasoning: 100, cacheRead: 0, cacheWrite: 0 },
      cost: 0.05,
      model: "gpt-4",
      provider: "openai",
      updated: Date.parse("2026-07-15T12:00:00.000Z"),
      created: 1,
      duration: 90_000,
    },
    {
      sessionID: "s2",
      title: "Pairing flow",
      directory: "/tmp",
      messages: 4,
      tokens: { input: 200, output: 80, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0.01,
      model: "claude-3",
      provider: "anthropic",
      updated: Date.parse("2026-07-15T11:00:00.000Z"),
      created: 1,
      duration: 3_600_000,
    },
  ]
  stats.days = [
    day("2026-07-01", { tokens: 100, sessions: 1, messages: 8, cost: 0.1, input: 60, output: 40 }),
    day("2026-07-02", { tokens: 200, sessions: 2, messages: 12, cost: 0.2, input: 120, output: 80 }),
    day("2026-07-03", { tokens: 150, sessions: 1, messages: 9, cost: 0.15, input: 90, output: 60 }),
    day("2026-07-08", { tokens: 400, sessions: 3, messages: 20, cost: 0.4, input: 240, output: 160 }),
    day("2026-07-09", { tokens: 350, sessions: 2, messages: 18, cost: 0.3, input: 200, output: 150 }),
    day("2026-07-10", { tokens: 500, sessions: 4, messages: 24, cost: 0.5, input: 300, output: 200 }),
  ]
  return stats
}

describe("buildCommandCenterSpec", () => {
  it("emits a catalog-valid command-center spec from live analytics", () => {
    const spec = buildCommandCenterSpec(makeStats(), {
      items: [{ label: "MCP filesystem", status: "success", detail: "connected" }],
      source: "live+history",
      historyLoading: false,
      refreshedAt: Date.parse("2026-07-15T12:00:00.000Z"),
    })
    const checked = VizCatalog.validate(spec)
    expect(checked.valid).toBe(true)
    expect(checked.dropped).toBe(0)
    expect(spec.title).toBe("nikcli Command Center")
    expect(spec.subtitle).toContain("12 sessions")
    expect(spec.components.length).toBeGreaterThanOrEqual(7)
    expect(spec.components.map((c) => c.type)).toEqual([
      "alert",
      "grid",
      "section",
      "section",
      "compare",
      "section",
      "accordion",
      "table",
    ])
  })

  it("still renders a readable empty state when there is no history", () => {
    const spec = buildCommandCenterSpec(emptyStats(), {
      items: [],
      source: "live",
      historyLoading: false,
      refreshedAt: 0,
    })
    const checked = VizCatalog.validate(spec)
    expect(checked.valid).toBe(true)
    expect(checked.dropped).toBe(0)
    expect(spec.components.length).toBeGreaterThan(0)
    const table = spec.components.find((c) => c.type === "table")
    expect(table?.type).toBe("table")
    if (table?.type === "table") {
      expect(table.rows[0]?.[1]).toBe("No sessions")
    }
  })
})

describe("latticeFromSync", () => {
  it("maps MCP and LSP status onto the lattice strip", () => {
    const items = latticeFromSync({
      mcp: {
        filesystem: { status: "connected" },
        github: { status: "failed", error: "token expired" },
        slack: { status: "needs_auth" },
      },
      lsp: [
        { id: "typescript", status: "connected", root: "/repo" },
        { id: "gopls", status: "error" },
      ],
    })
    expect(items).toEqual([
      { label: "MCP filesystem", status: "success", detail: "connected" },
      { label: "MCP github", status: "error", detail: "token expired" },
      { label: "MCP slack", status: "warning", detail: "needs_auth" },
      { label: "LSP typescript", status: "success", detail: "/repo" },
      { label: "LSP gopls", status: "error", detail: "error" },
    ])
  })
})
