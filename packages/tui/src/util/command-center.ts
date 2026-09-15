/**
 * Command-center dashboard — a dense OpenTUI viz spec built from live
 * analytics plus the TUI lattice (MCP / LSP / workspaces).
 *
 * Kept free of Solid/OpenTUI imports so it can be unit-tested the same way
 * as `analytics-utils.ts`. The dialog mounts `Renderer` on the resulting spec.
 */
import type { AggregatedStats, DayStats } from "./analytics-aggregator";
import {
  buildDurationHistogram,
  formatCompact,
  formatRelativeTime,
  periodDelta,
  sampleForSparkline,
  weightedToolSuccess,
} from "./analytics-utils";
import {
  VizCatalog,
  type OpenTUIVizSpecType,
  type VizComponent,
  type VizSeverity,
} from "@nikcli-ai/util/viz";

export type CommandCenterSource = "live" | "live+history";

export type CommandCenterLatticeItem = {
  label: string;
  status: VizSeverity;
  detail: string;
};

export type CommandCenterLattice = {
  items: CommandCenterLatticeItem[];
  source: CommandCenterSource;
  historyLoading: boolean;
  refreshedAt: number;
};

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function finite(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback;
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, finite(n)));
}

function padSeries(values: number[], min = 2): number[] {
  const clean = values.map((v) => finite(v));
  if (clean.length >= min) return clean;
  if (clean.length === 1) return [clean[0]!, clean[0]!];
  return [0, 0];
}

function last(values: number[]): number {
  return values[values.length - 1] ?? 0;
}

function mondayIndex(date: string): number {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return (day + 6) % 7;
}

function activityHeatmap(days: DayStats[]): {
  rowLabels: string[];
  colLabels: string[];
  values: number[][];
} {
  const window = days.slice(-28);
  if (window.length === 0) {
    return {
      rowLabels: [...WEEKDAYS],
      colLabels: ["W1"],
      values: WEEKDAYS.map(() => [0]),
    };
  }
  const weeks = Math.max(1, Math.ceil(window.length / 7));
  const values = WEEKDAYS.map(() => Array.from({ length: weeks }, () => 0));
  const first = window[0]!.date;
  const origin = Date.parse(`${first}T00:00:00.000Z`);
  for (const day of window) {
    const ts = Date.parse(`${day.date}T00:00:00.000Z`);
    if (!Number.isFinite(ts)) continue;
    const week = Math.min(
      weeks - 1,
      Math.max(0, Math.floor((ts - origin) / (7 * 24 * 60 * 60 * 1000))),
    );
    values[mondayIndex(day.date)]![week] = finite(day.tokens);
  }
  return {
    rowLabels: [...WEEKDAYS],
    colLabels: Array.from({ length: weeks }, (_, i) => `W${i + 1}`),
    values,
  };
}

function sourceLabel(lattice: CommandCenterLattice): string {
  if (lattice.source === "live+history") return "live sync + persisted history";
  if (lattice.historyLoading) return "live sync · loading history…";
  return "live sync";
}

function refreshedLabel(at: number): string {
  if (at <= 0) return "now";
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function rangeLabel(days: DayStats[]): string {
  const first = days.find(
    (d) => d.tokens > 0 || d.messages > 0 || d.cost > 0,
  )?.date;
  const lastDay = [...days]
    .reverse()
    .find((d) => d.tokens > 0 || d.messages > 0 || d.cost > 0)?.date;
  if (first && lastDay) return `${first} → ${lastDay}`;
  return "current activity";
}

function deltaText(
  trend: "up" | "down" | "flat",
  absolute: number,
  format: (n: number) => string,
): string {
  const sign = trend === "up" ? "+" : "";
  return `${sign}${format(absolute)}`;
}

/**
 * Build the command-center visualization. Always returns a catalog-valid spec
 * (empty accounts still get a readable empty state rather than a blank panel).
 */
export function buildCommandCenterSpec(
  stats: AggregatedStats,
  lattice: CommandCenterLattice,
): OpenTUIVizSpecType {
  const g = stats.global;
  const tokens = g.tokens;
  const nonCache = tokens.input + tokens.output + tokens.reasoning;
  const last30 = stats.days.slice(-30);
  const last14 = last30.slice(-14);
  const tokenSeries = padSeries(last14.map((d) => d.tokens));
  const messageSeries = padSeries(last14.map((d) => d.messages));
  const costSeries = padSeries(last14.map((d) => d.cost));
  const sessionSeries = padSeries(last14.map((d) => d.sessions));
  const xLabels = last14.map((d) => d.date.slice(5));
  while (xLabels.length < tokenSeries.length)
    xLabels.push(xLabels[xLabels.length - 1] ?? "—");

  const sessionsDelta = periodDelta(last30, 7, (d) => d.sessions);
  const tokensDelta = periodDelta(last30, 7, (d) => d.tokens);
  const costDelta = periodDelta(last30, 7, (d) => d.cost);
  const messagesDelta = periodDelta(last30, 7, (d) => d.messages);

  const cacheDenom = tokens.cacheRead + tokens.input;
  const cacheHit = cacheDenom > 0 ? (tokens.cacheRead / cacheDenom) * 100 : 0;
  const ioDenom = tokens.input + tokens.output;
  const outputRatio = ioDenom > 0 ? (tokens.output / ioDenom) * 100 : 0;
  const activeRatio =
    g.sessions > 0 ? ((g.sessions - g.archivedSessions) / g.sessions) * 100 : 0;
  const bgSuccess =
    g.backgroundRuns.total > 0 ? g.backgroundRuns.successRate : 0;
  const toolSuccess = weightedToolSuccess(g.toolUsage);
  const todoRate = g.todos.total > 0 ? g.todos.completionRate : 0;

  const heatmap = activityHeatmap(last30);
  const duration = buildDurationHistogram(stats.sessions);
  const recent = [...stats.sessions]
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 6);
  const mix = [
    { label: "Input", value: finite(tokens.input), color: "primary" as const },
    {
      label: "Output",
      value: finite(tokens.output),
      color: "warning" as const,
    },
    {
      label: "Cache",
      value: finite(tokens.cacheRead + tokens.cacheWrite),
      color: "success" as const,
    },
    {
      label: "Reasoning",
      value: finite(tokens.reasoning),
      color: "accent" as const,
    },
  ].filter((item) => item.value > 0);
  const mixItems =
    mix.length > 0
      ? mix
      : [{ label: "Idle", value: 1, color: "muted" as const }];

  const activeDays = last30.filter(
    (d) => d.tokens > 0 || d.messages > 0 || d.cost > 0,
  ).length;
  const operational: CommandCenterLatticeItem[] = [
    {
      label: "Activity",
      detail:
        activeDays > 0
          ? `${activeDays} active days`
          : "No recorded activity yet",
      status: activeDays > 0 ? "success" : "info",
    },
    {
      label: "Tools",
      detail:
        g.toolUsage.total > 0
          ? `${toolSuccess.toFixed(1)}% weighted success`
          : "No tool calls recorded",
      status:
        g.toolUsage.total === 0
          ? "info"
          : toolSuccess >= 90
            ? "success"
            : toolSuccess >= 70
              ? "warning"
              : "error",
    },
    {
      label: "Background",
      detail:
        g.backgroundRuns.total === 0
          ? "No background runs"
          : `${g.backgroundRuns.completed} completed · ${g.backgroundRuns.running} running · ${g.backgroundRuns.error} failed`,
      status:
        g.backgroundRuns.error > 0
          ? "error"
          : g.backgroundRuns.running > 0
            ? "info"
            : g.backgroundRuns.total > 0
              ? "success"
              : "info",
    },
    {
      label: "Workspaces",
      detail:
        g.workspaces.total === 0
          ? "No workspaces connected"
          : `${g.workspaces.active} active · ${g.workspaces.disconnected} disconnected`,
      status:
        g.workspaces.disconnected > 0
          ? g.workspaces.active === 0
            ? "error"
            : "warning"
          : g.workspaces.active > 0
            ? "success"
            : "info",
    },
    ...lattice.items.slice(0, 8),
  ];

  const watch: string[] = [];
  if (g.workspaces.disconnected > 0)
    watch.push(`${g.workspaces.disconnected} workspace(s) disconnected`);
  if (g.backgroundRuns.error > 0)
    watch.push(`${g.backgroundRuns.error} background run(s) failed`);
  if (g.toolUsage.total > 0 && toolSuccess < 90)
    watch.push(`Tool success at ${toolSuccess.toFixed(1)}%`);
  for (const item of lattice.items) {
    if (item.status === "error" || item.status === "warning")
      watch.push(`${item.label}: ${item.detail}`);
  }

  const toolBadgeStatus: VizSeverity =
    g.toolUsage.total === 0
      ? "info"
      : toolSuccess >= 90
        ? "success"
        : toolSuccess >= 70
          ? "warning"
          : "error";
  const timelineEvents =
    recent.length > 0
      ? recent.map((session, index) => ({
          label: session.title || "Untitled session",
          status: (index === 0 ? "active" : "done") as "active" | "done",
          time: formatRelativeTime(session.updated),
          duration: money.format(session.cost),
          detail: `${formatCompact(session.tokens.input + session.tokens.output + session.tokens.reasoning)} tok · ${session.model || "—"}`,
        }))
      : [
          {
            label: "No sessions yet",
            status: "pending" as const,
            detail: "Open a session to populate this log",
          },
        ];

  const components: VizComponent[] = [
    {
      type: "alert",
      severity:
        lattice.historyLoading && lattice.source !== "live+history"
          ? "warning"
          : "info",
      title: "Data source",
      message: `${sourceLabel(lattice)} · ${rangeLabel(stats.days)} · refreshed ${refreshedLabel(lattice.refreshedAt)}`,
    },
    {
      type: "grid",
      columns: 4,
      children: [
        {
          type: "card",
          title: "Fleet",
          subtitle: "sessions",
          badge: {
            label: g.sessions > 0 ? "live" : "idle",
            status: g.sessions > 0 ? "success" : "info",
          },
          body: `${g.sessions - g.archivedSessions} unarchived · ${g.archivedSessions} archived`,
          metrics: [
            {
              label: "total",
              value: g.sessions,
              format: "compact",
              status: "success",
            },
            {
              label: "Δ7d",
              value: deltaText(
                sessionsDelta.trend,
                sessionsDelta.absolute,
                formatCompact,
              ),
            },
          ],
        },
        {
          type: "card",
          title: "Tokens",
          subtitle: "non-cache",
          badge: { label: formatCompact(nonCache), status: "info" },
          body: `in ${formatCompact(tokens.input)} · out ${formatCompact(tokens.output)}`,
          metrics: [
            {
              label: "total",
              value: nonCache,
              format: "compact",
              status: "info",
            },
            {
              label: "Δ7d",
              value: deltaText(
                tokensDelta.trend,
                tokensDelta.absolute,
                formatCompact,
              ),
            },
          ],
        },
        {
          type: "card",
          title: "Spend",
          subtitle: `${g.efficiency.costPer1kTokens.toFixed(4)}/1k`,
          badge: {
            label: money.format(g.cost),
            status: costDelta.trend === "up" ? "warning" : "success",
          },
          body: `${money.format(g.efficiency.costPerSession)} / session`,
          metrics: [
            { label: "total", value: money.format(g.cost), status: "warning" },
            {
              label: "Δ7d",
              value: deltaText(costDelta.trend, costDelta.absolute, (n) =>
                money.format(n),
              ),
            },
          ],
        },
        {
          type: "card",
          title: "Tools",
          subtitle: "weighted success",
          badge: {
            label: g.toolUsage.total > 0 ? `${toolSuccess.toFixed(0)}%` : "—",
            status: toolBadgeStatus,
          },
          body:
            g.toolUsage.total > 0
              ? `${formatCompact(g.toolUsage.total)} calls`
              : "No tool calls yet",
          metrics: [
            { label: "calls", value: g.toolUsage.total, format: "compact" },
            { label: "bg", value: g.backgroundRuns.total, format: "compact" },
          ],
        },
      ],
    },
    {
      type: "section",
      title: "Signal",
      description: "throughput and mix — last 14 days",
      children: [
        {
          type: "grid",
          columns: 2,
          children: [
            {
              type: "line_chart",
              title: "Tokens / day",
              height: 8,
              showLegend: true,
              showAxis: true,
              labels: xLabels.slice(-tokenSeries.length),
              series: [
                { name: "Tokens", values: tokenSeries, color: "primary" },
                { name: "Messages", values: messageSeries, color: "accent" },
              ],
            },
            {
              type: "line_chart",
              title: "Cost / day",
              height: 8,
              showLegend: true,
              showAxis: true,
              yUnit: "$",
              labels: xLabels.slice(-costSeries.length),
              series: [{ name: "Cost", values: costSeries, color: "warning" }],
            },
          ],
        },
        {
          type: "sparkline_row",
          title: "Realtime fabric",
          showValues: true,
          rows: [
            {
              label: "Sessions",
              values: sampleForSparkline(sessionSeries, 14),
              color: "primary",
              current: last(sessionSeries),
              delta: sessionsDelta.absolute,
            },
            {
              label: "Messages",
              values: sampleForSparkline(messageSeries, 14),
              color: "info",
              current: last(messageSeries),
              delta: messagesDelta.absolute,
            },
            {
              label: "Tokens",
              values: sampleForSparkline(tokenSeries, 14),
              format: "compact",
              color: "accent",
              current: last(tokenSeries),
              delta: tokensDelta.absolute,
            },
            {
              label: "Cost",
              values: sampleForSparkline(costSeries, 14),
              format: "currency",
              color: "warning",
              current: last(costSeries),
              delta: costDelta.absolute,
            },
          ],
        },
      ],
    },
    {
      type: "section",
      title: "Composition",
      description: "where tokens, time and activity actually go",
      children: [
        {
          type: "grid",
          columns: 3,
          children: [
            {
              type: "gauge",
              title: "Cache",
              label: "hit ratio",
              value: clampPct(cacheHit),
              max: 100,
              unit: "%",
              thresholds: [
                { at: 20, color: "warning" },
                { at: 50, color: "success" },
              ],
            },
            {
              type: "gauge",
              title: "Output",
              label: "out / (in+out)",
              value: clampPct(outputRatio),
              max: 100,
              unit: "%",
            },
            {
              type: "gauge",
              title: "Sessions",
              label: "unarchived",
              value: clampPct(activeRatio),
              max: 100,
              unit: "%",
            },
          ],
        },
        {
          type: "grid",
          columns: 2,
          children: [
            {
              type: "bar_chart",
              title: "Token mix",
              orientation: "horizontal",
              showValues: true,
              showPercentages: true,
              items: mixItems,
            },
            {
              type: "histogram",
              title: "Session duration",
              unit: "sessions",
              bins: duration.map((bin) => ({
                label: bin.label,
                count: bin.count,
              })),
            },
          ],
        },
        {
          type: "heatmap",
          title: "Activity · weekday × week",
          colorScale: "mono",
          unit: "tokens",
          rowLabels: heatmap.rowLabels,
          colLabels: heatmap.colLabels,
          values: heatmap.values,
        },
      ],
    },
    {
      type: "compare",
      title: "Last 7 days vs prior 7",
      leftLabel: "current",
      rightLabel: "previous",
      rows: [
        {
          label: "Sessions",
          left: formatCompact(sessionsDelta.current),
          right: formatCompact(sessionsDelta.previous),
          winner:
            sessionsDelta.trend === "up"
              ? "left"
              : sessionsDelta.trend === "down"
                ? "right"
                : "tie",
        },
        {
          label: "Tokens",
          left: formatCompact(tokensDelta.current),
          right: formatCompact(tokensDelta.previous),
          winner:
            tokensDelta.trend === "up"
              ? "left"
              : tokensDelta.trend === "down"
                ? "right"
                : "tie",
        },
        {
          label: "Cost",
          left: money.format(costDelta.current),
          right: money.format(costDelta.previous),
          winner:
            costDelta.trend === "down"
              ? "left"
              : costDelta.trend === "up"
                ? "right"
                : "tie",
          note: "lower is better",
        },
        {
          label: "Messages",
          left: formatCompact(messagesDelta.current),
          right: formatCompact(messagesDelta.previous),
          winner:
            messagesDelta.trend === "up"
              ? "left"
              : messagesDelta.trend === "down"
                ? "right"
                : "tie",
        },
      ],
    },
    {
      type: "section",
      title: "Surfaces",
      description: "lattice health, capacity, last sessions",
      children: [
        {
          type: "status_grid",
          title: "Lattice",
          columns: 4,
          items: operational.slice(0, 12),
        },
        {
          type: "progress_bars",
          title: "Capacity envelope",
          barWidth: 28,
          thresholds: [
            { at: 70, color: "warning" },
            { at: 90, color: "error" },
          ],
          items: [
            {
              label: "Unarchived",
              value: Math.max(0, g.sessions - g.archivedSessions),
              max: Math.max(1, g.sessions),
              unit: "ses",
            },
            {
              label: "Background ok",
              value: clampPct(bgSuccess),
              max: 100,
              unit: "%",
            },
            {
              label: "Todos done",
              value: clampPct(todoRate),
              max: 100,
              unit: "%",
            },
            {
              label: "Cache hit",
              value: clampPct(cacheHit),
              max: 100,
              unit: "%",
            },
          ],
        },
        {
          type: "timeline",
          title: "Recent sessions",
          events: timelineEvents,
        },
      ],
    },
    {
      type: "accordion",
      title: "Drill-down",
      sections: [
        {
          title: "Watch items",
          subtitle: watch.length > 0 ? `${watch.length} open` : "all clear",
          open: watch.length > 0,
          content:
            watch.length > 0
              ? watch.map((item) => `- ${item}`).join("\n")
              : "Nothing paging. Lattice is quiet.",
        },
        {
          title: "Efficiency",
          subtitle: `${money.format(g.efficiency.costPerSession)} / session`,
          items: [
            {
              key: "Cost / 1k tokens",
              value: g.efficiency.costPer1kTokens.toFixed(4),
            },
            {
              key: "Avg tokens / session",
              value: formatCompact(g.efficiency.avgTokensPerSession),
            },
            {
              key: "Avg cost / day",
              value: money.format(g.efficiency.avgCostPerDay),
            },
            {
              key: "Background success",
              value: `${bgSuccess.toFixed(1)}%`,
              status: bgSuccess >= 90 ? "success" : "warning",
            },
          ],
        },
      ],
    },
    {
      type: "table",
      title: "Handshake log · recent sessions",
      headers: ["When", "Title", "Model", "Tokens", "Cost"],
      align: ["left", "left", "left", "right", "right"],
      rows:
        recent.length > 0
          ? recent.map((session) => [
              formatRelativeTime(session.updated),
              (session.title || "Untitled").slice(0, 32),
              session.model || "—",
              formatCompact(
                session.tokens.input +
                  session.tokens.output +
                  session.tokens.reasoning,
              ),
              money.format(session.cost),
            ])
          : [["—", "No sessions", "—", "0", money.format(0)]],
    },
  ];

  return VizCatalog.validate({
    title: "nikcli Command Center",
    subtitle: `${rangeLabel(stats.days)} · ${g.sessions} sessions · ${formatCompact(nonCache)} tokens · ${money.format(g.cost)}`,
    components,
  }).spec;
}

/** MCP / LSP rows for the lattice strip. Status strings match the sync store. */
export function latticeFromSync(input: {
  mcp: Record<string, { status: string; error?: string }>;
  lsp: Array<{ id: string; status: string; root?: string }>;
}): CommandCenterLatticeItem[] {
  const items: CommandCenterLatticeItem[] = [];
  for (const [name, item] of Object.entries(input.mcp)) {
    const status: VizSeverity =
      item.status === "connected"
        ? "success"
        : item.status === "failed" ||
            item.status === "needs_client_registration"
          ? "error"
          : item.status === "needs_auth"
            ? "warning"
            : "info";
    items.push({
      label: `MCP ${name}`,
      status,
      detail: item.status === "failed" && item.error ? item.error : item.status,
    });
  }
  for (const item of input.lsp) {
    items.push({
      label: `LSP ${item.id}`,
      status:
        item.status === "connected"
          ? "success"
          : item.status === "error"
            ? "error"
            : "info",
      detail: item.root ?? item.status,
    });
  }
  return items.slice(0, 8);
}
