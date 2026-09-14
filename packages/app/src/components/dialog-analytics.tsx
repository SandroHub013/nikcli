import { Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Dialog } from "@nikcli-ai/ui/dialog"
import { AreaChart, ShareBar } from "@nikcli-ai/ui/chart"
import { AnimatedNumber } from "@nikcli-ai/ui/animated-number"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { useGlobalSync } from "@/context/global-sync"

type WindowDays = 7 | 30 | 90

type AnalyticsData = {
  totals: {
    tokens: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    sessions: number
    messages: number
    toolCalls: number
    costUsd: number
    models: number
    providers: number
    tokensPerSession: number
    cacheRatio: number | null
    change: number | null
  }
  models: Array<{ model: string; provider: string; tokens: number; sessions: number; share: number }>
  series: Array<{ day: string; byModel: Record<string, number>; tokens: number; sessions: number }>
  seriesModels: string[]
} | null

type Leaderboard = {
  providers: Array<{ id: string; sessions: number; tokens: number; cost: number }>
  projects: Array<{ id: string; sessions: number; tokens: number; cost: number; lastActive: number }>
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })

function compact(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(Math.round(value))
}

function shortDay(value: string | number): string {
  const [, month, day] = String(value).split("-")
  return month && day ? `${day}/${month}` : String(value)
}

/** Only the last path segment of a project directory is worth reading. */
function directoryName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

const Stat: Component<{
  label: string
  value: number
  format: (value: number) => string
  delta?: number | null
}> = (props) => (
  <div data-slot="analytics-stat">
    <span data-slot="analytics-stat-label">{props.label}</span>
    <span data-slot="analytics-stat-value">
      <AnimatedNumber value={props.value} format={props.format} />
      <Show when={props.delta !== null && props.delta !== undefined && Number.isFinite(props.delta)}>
        <span data-slot="analytics-delta" data-direction={(props.delta ?? 0) >= 0 ? "up" : "down"}>
          {(props.delta ?? 0) >= 0 ? "+" : ""}
          {Math.round((props.delta ?? 0) * 100)}%
        </span>
      </Show>
    </span>
  </div>
)

export const DialogAnalytics: Component = () => {
  const sdk = useSDK()
  const language = useLanguage()
  const globalSync = useGlobalSync()
  const [windowDays, setWindowDays] = createSignal<WindowDays>(30)

  // The leaderboard keys projects by their opaque id; the sync store is the only
  // place that knows what those ids are actually called.
  const projectLabel = (id: string) => {
    const match = globalSync.data.project.find((project) => project.id === id)
    if (match) return match.name || directoryName(match.worktree)
    return id.length > 12 ? `${id.slice(0, 8)}…` : id
  }

  const [payload] = createResource(windowDays, async (days) => {
    const data = await sdk.client.analytics.data({ days: String(days), seriesDays: String(days) })
    return data.data as AnalyticsData
  })

  // Separate on purpose: `/analytics/leaderboard` declares no query schema, so
  // it answers with lifetime totals whatever is selected. Refetching it per
  // window spent a request to receive the same numbers back.
  const [leaderboard] = createResource(async () => {
    const result = await sdk.client.analytics.leaderboard()
    return result.data as Leaderboard | undefined
  })

  const data = createMemo(() => (payload.error ? null : (payload() ?? null)))
  const totals = createMemo(() => data()?.totals)

  // The stacked chart stays legible at five bands; everything else is already
  // folded into the server's "other" bucket.
  const chartSeries = createMemo(() => {
    const models = data()?.seriesModels ?? []
    return models.slice(0, 6).map((model) => ({ key: model, label: model }))
  })

  const chartData = createMemo(() =>
    (data()?.series ?? []).map((point) => {
      const row: Record<string, string | number> = { day: point.day }
      for (const model of data()?.seriesModels ?? []) row[model] = point.byModel[model] ?? 0
      return row
    }),
  )

  const topModels = createMemo(() => (data()?.models ?? []).slice(0, 6))
  const providers = createMemo(() => (leaderboard.error ? [] : (leaderboard()?.providers ?? [])).slice(0, 5))
  const projects = createMemo(() => (leaderboard.error ? [] : (leaderboard()?.projects ?? [])).slice(0, 5))

  return (
    <Dialog
      size="large"
      title={language.t("dialog.analytics.title")}
      description={language.t("dialog.analytics.description")}
    >
      <div data-component="analytics">
        <div data-slot="analytics-windows">
          <For each={[7, 30, 90] as WindowDays[]}>
            {(days) => (
              <button
                type="button"
                data-slot="analytics-window"
                data-active={windowDays() === days}
                onClick={() => setWindowDays(days)}
              >
                {days}d
              </button>
            )}
          </For>
        </div>

        <Show
          when={totals()}
          fallback={
            <span class="text-13-regular text-text-weak">
              {/*
                The client is built with `throwOnError`, so a failed request
                rejects the resource. Reading `payload()` without checking
                `payload.error` first rethrows inside the render and the nearest
                boundary is the one at the root — a server restart while this
                dialog is open replaced the whole app with the error page.
              */}
              {payload.error
                ? language.t("dialog.analytics.failed")
                : payload.loading
                  ? language.t("common.loading.ellipsis")
                  : language.t("dialog.analytics.empty")}
            </span>
          }
        >
          {(t) => (
            <>
              <div data-slot="analytics-stats">
                <Stat
                  label={language.t("dialog.analytics.tokens")}
                  value={t().tokens}
                  format={compact}
                  delta={t().change}
                />
                <Stat label={language.t("dialog.analytics.sessions")} value={t().sessions} format={compact} />
                <Stat label={language.t("dialog.analytics.messages")} value={t().messages} format={compact} />
                <Stat label={language.t("dialog.analytics.toolCalls")} value={t().toolCalls} format={compact} />
                <Stat
                  label={language.t("dialog.analytics.cacheHit")}
                  value={(t().cacheRatio ?? 0) * 100}
                  format={(value) => `${value.toFixed(0)}%`}
                />
                <Stat
                  label={language.t("dialog.analytics.cost")}
                  value={t().costUsd}
                  format={(value) => money.format(value)}
                />
              </div>

              <section data-slot="analytics-section">
                <header data-slot="analytics-section-head">
                  <span>{language.t("dialog.analytics.tokensPerDay")}</span>
                  <span data-slot="analytics-section-meta">
                    {compact(t().tokensPerSession)} {language.t("dialog.analytics.perSession")}
                  </span>
                </header>
                <AreaChart
                  data={chartData()}
                  series={chartSeries()}
                  xKey="day"
                  stacked
                  height={160}
                  format={compact}
                  formatX={shortDay}
                  status={payload.loading ? "loading" : "ready"}
                  empty={language.t("dialog.analytics.empty")}
                />
              </section>

              <Show when={topModels().length > 0}>
                <section data-slot="analytics-section">
                  <header data-slot="analytics-section-head">
                    <span>{language.t("dialog.analytics.byModel")}</span>
                    <span data-slot="analytics-section-meta">{t().models}</span>
                  </header>
                  <ShareBar
                    segments={topModels().map((model) => ({
                      key: model.model,
                      label: model.model,
                      value: model.tokens,
                    }))}
                    format={compact}
                  />
                  <ul data-slot="analytics-list">
                    <For each={topModels()}>
                      {(model, index) => (
                        <li data-slot="analytics-row" style={{ "animation-delay": `${index() * 40}ms` }}>
                          <span data-slot="analytics-swatch" style={{ background: `var(--chart-${(index() % 6) + 1})` }} />
                          <span data-slot="analytics-row-name">{model.model}</span>
                          <span data-slot="analytics-row-sub">{model.provider}</span>
                          <span data-slot="analytics-row-value">{compact(model.tokens)}</span>
                          <span data-slot="analytics-row-share">{Math.round(model.share * 100)}%</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </Show>

              <div data-slot="analytics-columns">
                <Show when={providers().length > 0}>
                  <section data-slot="analytics-section">
                    <header data-slot="analytics-section-head">
                      <span>{language.t("dialog.analytics.byProvider")}</span>
                      <span class="text-11-regular text-text-weak">{language.t("dialog.analytics.allTime")}</span>
                    </header>
                    <ul data-slot="analytics-list">
                      <For each={providers()}>
                        {(provider, index) => (
                          <li data-slot="analytics-row" style={{ "animation-delay": `${index() * 40}ms` }}>
                            <span data-slot="analytics-row-name">{provider.id}</span>
                            <span data-slot="analytics-row-value">{compact(provider.tokens)}</span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </section>
                </Show>

                <Show when={projects().length > 0}>
                  <section data-slot="analytics-section">
                    <header data-slot="analytics-section-head">
                      <span>{language.t("dialog.analytics.byProject")}</span>
                      <span class="text-11-regular text-text-weak">{language.t("dialog.analytics.allTime")}</span>
                    </header>
                    <ul data-slot="analytics-list">
                      <For each={projects()}>
                        {(project, index) => (
                          <li data-slot="analytics-row" style={{ "animation-delay": `${index() * 40}ms` }}>
                            <span data-slot="analytics-row-name" title={project.id}>
                              {projectLabel(project.id)}
                            </span>
                            <span data-slot="analytics-row-value">{compact(project.tokens)}</span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </section>
                </Show>
              </div>
            </>
          )}
        </Show>
      </div>
    </Dialog>
  )
}
