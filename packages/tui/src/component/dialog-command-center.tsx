import { FooterHint } from "@tui/ui/footer-hints"
import { useScrollAcceleration } from "@tui/util/scroll"
import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useTheme } from "@tui/context/theme"
import { useSync } from "@tui/context/sync"
import { useAnalytics } from "@tui/context/analytics"
import {
  aggregateAnalytics,
  augmentAggregatedStatsFromPersistedSessions,
  mergeSessionsFromApi,
  mergeWithHistorical,
  type AggregatedStats,
} from "@tui/util/analytics-aggregator"
import { computeAnalyticsDialogLayout } from "@tui/util/analytics-utils"
import { buildCommandCenterSpec, latticeFromSync, type CommandCenterSource } from "@tui/util/command-center"
import { Renderer } from "@tui/component/dialog-opentui-viz"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

export function DialogCommandCenter() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const sync = useSync()
  const analyticsCtx = useAnalytics()
  const dimensions = useTerminalDimensions()
  const scrollAcceleration = useScrollAcceleration()
  const layout = createMemo(() => computeAnalyticsDialogLayout(dimensions().width, dimensions().height))
  const contentHeight = createMemo(() => layout().contentHeight)

  const [loading, setLoading] = createSignal(true)
  const [stats, setStats] = createSignal<AggregatedStats | null>(null)
  const [source, setSource] = createSignal<CommandCenterSource>("live")
  const [loadError, setLoadError] = createSignal<string>()
  const [refreshedAt, setRefreshedAt] = createSignal(0)
  const [spinner, setSpinner] = createSignal(0)

  let liveBase: AggregatedStats | null = null

  function withHistory(live: AggregatedStats, gotHistorical: boolean): AggregatedStats {
    let merged = gotHistorical
      ? mergeWithHistorical(live, {
          global: analyticsCtx.global(),
          daily: analyticsCtx.daily(),
        })
      : live
    const persisted = analyticsCtx.sessions()
    if (persisted.length > 0) {
      merged = {
        ...merged,
        sessions: mergeSessionsFromApi(merged.sessions, persisted),
      }
      merged = augmentAggregatedStatsFromPersistedSessions(merged, persisted)
    }
    return merged
  }

  async function waitForSyncBootstrap() {
    const started = Date.now()
    const maxWait = 15_000
    while (Date.now() - started < maxWait) {
      if (sync.status === "complete") return
      if (sync.ready && sync.data.session.length > 0) return
      if (sync.ready && Date.now() - started > 2_500) return
      await new Promise((r) => setTimeout(r, 40))
    }
  }

  async function load() {
    setLoading(true)
    setLoadError(undefined)
    try {
      await waitForSyncBootstrap()
      const liveStats = aggregateAnalytics({
        session: sync.data.session,
        message: sync.data.message,
        part: sync.data.part,
        todo: sync.data.todo,
        workspaceList: sync.data.workspaceList,
        background_job: sync.data.background_job,
      })
      liveBase = liveStats
      setSource("live")
      setStats(liveStats)
      setRefreshedAt(Date.now())
      setLoading(false)

      const gotHistorical = await analyticsCtx.refresh().catch(() => false)
      if (gotHistorical) {
        setSource("live+history")
        setStats(withHistory(liveStats, true))
        setRefreshedAt(Date.now())
      }
      void analyticsCtx.refreshSessions().then(() => {
        if (liveBase) setStats(withHistory(liveBase, source() === "live+history"))
      })
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Command center could not be loaded")
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    dialog.setSize("xlarge")
    const spin = setInterval(() => {
      if (loading()) setSpinner((f) => (f + 1) % SPINNER_FRAMES.length)
    }, 90)
    const unwatch = analyticsCtx.watch()
    onCleanup(() => {
      clearInterval(spin)
      unwatch()
    })
    void load()
  })

  useKeyboard((evt) => {
    if (evt.name === "r" && !evt.ctrl && !evt.meta) {
      void load()
      evt.preventDefault?.()
      evt.stopPropagation?.()
    }
  })

  const spec = createMemo(() => {
    const current = stats()
    if (!current) return undefined
    return buildCommandCenterSpec(current, {
      items: latticeFromSync({ mcp: sync.data.mcp, lsp: sync.data.lsp }),
      source: source(),
      historyLoading: analyticsCtx.loading(),
      refreshedAt: refreshedAt(),
    })
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" gap={1}>
        <box flexDirection="column" gap={0}>
          <text fg={theme.accent.alt} attributes={TextAttributes.BOLD} wrapMode="none">
            ◈ COMMAND CENTER
          </text>
          <Show when={spec()}>
            <text fg={theme.foreground.muted} wrapMode="none">
              {spec()!.subtitle}
            </text>
          </Show>
        </box>
        <text fg={theme.foreground.muted} wrapMode="none">
          r refresh · ↑↓ scroll · esc
        </text>
      </box>

      <Show when={loading() && !stats()}>
        <box height={contentHeight()} alignItems="center" justifyContent="center" flexShrink={0}>
          <box flexDirection="row" gap={1} alignItems="center">
            <text fg={theme.accent.alt} wrapMode="none">
              {SPINNER_FRAMES[spinner()]}
            </text>
            <text fg={theme.foreground.muted} wrapMode="none">
              Assembling command center…
            </text>
          </box>
        </box>
      </Show>

      <Show when={!loading() && !stats()}>
        <box
          height={contentHeight()}
          border
          borderColor={theme.status.error.fg}
          alignItems="center"
          justifyContent="center"
          flexShrink={0}
        >
          <box flexDirection="column" gap={1} alignItems="center" paddingLeft={2} paddingRight={2}>
            <text fg={theme.status.error.fg} attributes={TextAttributes.BOLD} wrapMode="none">
              ✗ Command center unavailable
            </text>
            <text fg={theme.foreground.muted} wrapMode="word">
              {loadError() ?? "No analytics data was returned"}
            </text>
            <text fg={theme.accent.fg} onMouseUp={() => void load()} wrapMode="none">
              [r / click to retry]
            </text>
          </box>
        </box>
      </Show>

      <Show when={stats() && spec()}>
        <box border borderColor={theme.border.default} height={contentHeight()} flexShrink={0}>
          <scrollbox
            scrollAcceleration={scrollAcceleration()}
            height={contentHeight() - 2}
            focused={true}
            scrollbarOptions={{ visible: true }}
          >
            <box paddingTop={1} paddingBottom={1} paddingLeft={1} paddingRight={1}>
              <Renderer spec={spec()!} loading={analyticsCtx.loading() && source() !== "live+history"} />
            </box>
          </scrollbox>
        </box>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <FooterHint keys="r" label="refresh" />
          <FooterHint keys="↑↓" label="scroll" />
          <FooterHint keys="esc" label="close" />
        </box>
      </Show>
    </box>
  )
}
