import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ActivityIndicator,
  Animated,
  Easing,
  LayoutAnimation,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native"
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronDown,
  CircleDashed,
  CirclePause,
  ExternalLink,
  Minus,
  Play,
  RotateCcw,
  Timer,
  X,
} from "lucide-react-native"
import {
  getCardAnimatedStyle,
  useAnimatedValue,
  useItemAnimation,
  usePrefersReducedMotion,
  usePressAnimation,
  useToggleAnimation,
} from "@/lib/animation"
import { triggerHaptic } from "@/lib/haptics"
import { useUIStore } from "@/lib/store"
import { hexToRgba, useAppTheme, type ThemeColors } from "@/lib/theme"
import { caps, mono, type as typeStyle } from "@/lib/typography"
import { relativeTime, type WorkflowJob, type WorkflowRun } from "@/lib/types"
import { EmptyState } from "@/components/ui/EmptyState"
import { ErrorBanner } from "@/components/ui/ErrorBanner"

type Scope = "branch" | "all"

/** Runs held by the list and summarised by the health strip. */
const RUN_LIMIT = 20

/** Poll cadence. A repository with something in flight earns the fast one. */
const POLL_LIVE_MS = 6_000
const POLL_IDLE_MS = 30_000

interface GitActionsPanelProps {
  owner: string
  repo: string
  /** Head branch of the session — the default scope. */
  branch?: string
  /** Scopes the mobile client to the session's worktree, like the rest of the modal. */
  directory?: string
  /** False while another tab is showing: polling and the elapsed clock stop. */
  active: boolean
  bottomInset?: number
  /** Lets the host badge CI state while this panel is not the visible tab. */
  onSummary?(summary: { running: number; failing: number }): void
}

/* ------------------------------------------------------------------ status */

type Tone = "running" | "queued" | "success" | "failure" | "cancelled" | "neutral" | "attention"

type StatusView = {
  tone: Tone
  label: string
  Icon: typeof Check
  /** Continuous rotation — only for the states that are genuinely still moving. */
  spin: boolean
}

/**
 * GitHub's `status` × `conclusion` pair collapsed into the one thing the UI needs.
 *
 * Both arrive as open strings on purpose (GitHub keeps adding members), so the fallthrough is
 * a real case rather than a defensive `default`: an unknown member renders neutral with its
 * own name instead of a blank row.
 */
function statusView(status: string, conclusion?: string): StatusView {
  if (status === "in_progress") return { tone: "running", label: "Running", Icon: CircleDashed, spin: true }
  if (status === "queued" || status === "pending" || status === "requested")
    return { tone: "queued", label: "Queued", Icon: Timer, spin: false }
  if (status === "waiting") return { tone: "attention", label: "Waiting", Icon: CirclePause, spin: false }

  switch (conclusion) {
    case "success":
      return { tone: "success", label: "Passed", Icon: Check, spin: false }
    case "failure":
      return { tone: "failure", label: "Failed", Icon: X, spin: false }
    case "timed_out":
      return { tone: "failure", label: "Timed out", Icon: Timer, spin: false }
    case "startup_failure":
      return { tone: "failure", label: "Startup failed", Icon: AlertTriangle, spin: false }
    case "cancelled":
      return { tone: "cancelled", label: "Cancelled", Icon: Ban, spin: false }
    case "skipped":
      return { tone: "neutral", label: "Skipped", Icon: Minus, spin: false }
    case "stale":
      return { tone: "neutral", label: "Stale", Icon: Minus, spin: false }
    case "action_required":
      return { tone: "attention", label: "Action required", Icon: AlertTriangle, spin: false }
    case "neutral":
      return { tone: "neutral", label: "Neutral", Icon: Minus, spin: false }
    default:
      return status === "completed"
        ? { tone: "neutral", label: "Completed", Icon: Check, spin: false }
        : { tone: "neutral", label: status.replace(/_/g, " "), Icon: CircleDashed, spin: false }
  }
}

/** Every tone resolves through the palette, so all themes and both modes keep working. */
function toneColor(palette: ThemeColors, tone: Tone) {
  switch (tone) {
    case "success":
      return palette.success
    case "failure":
      return palette.danger
    case "running":
      return palette.accentLight
    case "queued":
    case "attention":
      return palette.warn
    default:
      return palette.muted
  }
}

const isLive = (run: WorkflowRun) => run.status !== "completed"

/* ----------------------------------------------------------------- helpers */

/** `12s` / `1m 04s` / `1h 02m`, rendered tabular so a ticking clock never shifts the row. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, "0")
  if (hours > 0) return `${hours}h ${pad(minutes)}m`
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`
  return `${seconds}s`
}

/**
 * A clock that ticks only while something is actually running.
 *
 * A running job's elapsed time has to move without a refetch, but a second-by-second
 * re-render of a settled list is pure battery — so the interval exists only while `enabled`.
 */
function useTickingNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return undefined
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [enabled])
  return now
}

function elapsedOf(run: WorkflowRun, now: number) {
  if (run.durationMs !== undefined) return run.durationMs
  return Math.max(0, now - (run.startedAt ?? run.createdAt))
}

/* ------------------------------------------------------------ status glyph */

function StatusGlyph({ view, size = 28 }: { view: StatusView; size?: number }) {
  const { palette } = useAppTheme()
  const prefersReducedMotion = usePrefersReducedMotion()
  const spin = useAnimatedValue(0)
  const color = toneColor(palette, view.tone)
  const animate = view.spin && !prefersReducedMotion

  useEffect(() => {
    if (!animate) {
      spin.setValue(0)
      return undefined
    }
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 1600, easing: Easing.linear, useNativeDriver: true }),
    )
    loop.start()
    return () => loop.stop()
  }, [animate, spin])

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        borderColor: hexToRgba(color, 0.28),
        backgroundColor: hexToRgba(color, 0.14),
      }}
    >
      <Animated.View
        style={
          animate
            ? { transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] }
            : undefined
        }
      >
        <view.Icon size={Math.round(size * 0.52)} color={color} strokeWidth={2.6} />
      </Animated.View>
    </View>
  )
}

/* ------------------------------------------------------------ health strip */

/**
 * The recent runs as one row of bars, oldest left — the shape of the branch's health before a
 * single row is read. Failures stand tallest so a red streak is visible without colour alone.
 */
function HealthStrip({ runs, onSelect }: { runs: WorkflowRun[]; onSelect(run: WorkflowRun): void }) {
  const { palette } = useAppTheme()
  const prefersReducedMotion = usePrefersReducedMotion()
  const pulse = useAnimatedValue(0)
  const ordered = useMemo(() => runs.slice(0, 14).reverse(), [runs])
  const hasLive = ordered.some(isLive)

  useEffect(() => {
    if (!hasLive || prefersReducedMotion) {
      pulse.setValue(0)
      return undefined
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 760, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 760, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [hasLive, prefersReducedMotion, pulse])

  if (ordered.length === 0) return null

  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 4, height: 32 }}>
      {ordered.map((run) => {
        const view = statusView(run.status, run.conclusion)
        const color = toneColor(palette, view.tone)
        const live = isLive(run)
        return (
          <Pressable
            key={run.id}
            onPress={() => onSelect(run)}
            accessibilityRole="button"
            accessibilityLabel={`${run.name} number ${run.runNumber}, ${view.label}`}
            hitSlop={8}
            style={({ pressed }) => ({
              flex: 1,
              height: "100%",
              justifyContent: "flex-end",
              opacity: pressed ? 0.55 : 1,
            })}
          >
            <Animated.View
              style={{
                height: view.tone === "failure" ? "100%" : view.tone === "success" ? "70%" : "48%",
                borderRadius: 4,
                borderCurve: "continuous",
                backgroundColor: hexToRgba(color, live ? 0.6 : 0.85),
                ...(live ? { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) } : null),
              }}
            />
          </Pressable>
        )
      })}
    </View>
  )
}

/* ----------------------------------------------------------------- job row */

function JobRow({ job, now }: { job: WorkflowJob; now: number }) {
  const { palette } = useAppTheme()
  const view = statusView(job.status, job.conclusion)
  const color = toneColor(palette, view.tone)
  const done = job.steps.filter((step) => step.status === "completed").length
  const total = job.steps.length
  const duration =
    job.durationMs ?? (job.startedAt !== undefined && job.status !== "completed" ? now - job.startedAt : undefined)
  const url = job.htmlUrl

  return (
    <Pressable
      onPress={url ? () => void Linking.openURL(url).catch(() => undefined) : undefined}
      disabled={!url}
      accessibilityRole={url ? "link" : "text"}
      accessibilityLabel={`${job.name}, ${view.label}${total > 0 ? `, ${done} of ${total} steps` : ""}`}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: 44,
        paddingVertical: 6,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <StatusGlyph view={view} size={20} />
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: palette.ink, ...typeStyle(13, { weight: "600" }) }}>
          {job.name}
        </Text>
        {total > 0 ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 5 }}>
            <View
              style={{
                flex: 1,
                height: 3,
                borderRadius: 999,
                overflow: "hidden",
                backgroundColor: hexToRgba(palette.ink, 0.08),
              }}
            >
              <View
                style={{
                  width: `${Math.round((done / total) * 100)}%`,
                  height: "100%",
                  borderRadius: 999,
                  backgroundColor: color,
                }}
              />
            </View>
            <Text style={{ color: palette.muted, fontVariant: ["tabular-nums"], ...typeStyle(11) }}>
              {done}/{total}
            </Text>
          </View>
        ) : null}
      </View>
      {duration === undefined ? null : (
        <Text style={{ color: palette.muted, fontVariant: ["tabular-nums"], ...mono(11) }}>
          {formatDuration(duration)}
        </Text>
      )}
    </Pressable>
  )
}

/* ------------------------------------------------------------ action chips */

function ActionChip({
  label,
  Icon,
  tone = "neutral",
  busy,
  onPress,
}: {
  label: string
  Icon: typeof Play
  tone?: "neutral" | "danger"
  busy?: boolean
  onPress(): void
}) {
  const { palette } = useAppTheme()
  const press = usePressAnimation()
  const color = tone === "danger" ? palette.danger : palette.ink

  return (
    <Animated.View style={{ flex: 1, transform: [{ scale: press.scale }] }}>
      <Pressable
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ busy: Boolean(busy) }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          minHeight: 44,
          paddingHorizontal: 10,
          borderRadius: 14,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: hexToRgba(color, 0.16),
          backgroundColor: hexToRgba(color, 0.07),
          opacity: busy ? 0.55 : 1,
        }}
      >
        {busy ? <ActivityIndicator size="small" color={color} /> : <Icon size={14} color={color} strokeWidth={2.4} />}
        <Text numberOfLines={1} style={{ color, ...typeStyle(12, { weight: "600" }) }}>
          {label}
        </Text>
      </Pressable>
    </Animated.View>
  )
}

/* ---------------------------------------------------------------- run card */

function MetaDot() {
  const { palette } = useAppTheme()
  return <Text style={{ color: palette.muted, ...typeStyle(12) }}>·</Text>
}

function RunCard({
  run,
  index,
  expanded,
  jobs,
  jobsLoading,
  busy,
  now,
  onToggle,
  onRerun,
  onCancel,
}: {
  run: WorkflowRun
  index: number
  expanded: boolean
  jobs: WorkflowJob[] | undefined
  jobsLoading: boolean
  busy: boolean
  now: number
  onToggle(): void
  onRerun(failedOnly: boolean): void
  onCancel(): void
}) {
  const { palette, isDark } = useAppTheme()
  const anim = useItemAnimation(index, { delayMs: 38 })
  const turn = useToggleAnimation(expanded)
  const press = usePressAnimation()
  const view = statusView(run.status, run.conclusion)
  const color = toneColor(palette, view.tone)
  const live = isLive(run)
  const failed = view.tone === "failure"

  return (
    <Animated.View
      style={[
        {
          borderRadius: 20,
          borderCurve: "continuous",
          borderWidth: 1,
          // A live run is the only row allowed to tint its own edge: it is the one thing on
          // screen still changing, and the tint is what the eye returns to.
          borderColor: live ? hexToRgba(color, 0.32) : hexToRgba(palette.ink, isDark ? 0.09 : 0.08),
          backgroundColor: palette.surfaceRaised,
          overflow: "hidden",
        },
        getCardAnimatedStyle(anim, { intensity: "subtle" }),
      ]}
    >
      <Animated.View style={{ transform: [{ scale: press.scale }] }}>
        <Pressable
          onPress={onToggle}
          onPressIn={press.onPressIn}
          onPressOut={press.onPressOut}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={`${run.name} number ${run.runNumber}, ${view.label}. ${run.title}`}
          style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14 }}
        >
          <StatusGlyph view={view} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text numberOfLines={1} style={{ color: palette.ink, ...typeStyle(14, { weight: "600" }) }}>
              {run.title}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Text numberOfLines={1} style={{ flexShrink: 1, color: palette.soft, ...typeStyle(12) }}>
                {run.name}
              </Text>
              <MetaDot />
              <Text style={{ color: palette.muted, fontVariant: ["tabular-nums"], ...typeStyle(12) }}>
                #{run.runNumber}
              </Text>
              <MetaDot />
              <Text numberOfLines={1} style={{ color: palette.muted, ...typeStyle(12) }}>
                {relativeTime(run.updatedAt)}
              </Text>
            </View>
          </View>
          <View style={{ alignItems: "flex-end", gap: 3 }}>
            <Text style={{ color, ...caps(10) }}>{view.label}</Text>
            <Text style={{ color: palette.muted, fontVariant: ["tabular-nums"], ...mono(11) }}>
              {formatDuration(elapsedOf(run, now))}
            </Text>
          </View>
          <Animated.View
            style={{
              transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ["-90deg", "0deg"] }) }],
            }}
          >
            <ChevronDown size={16} color={palette.muted} strokeWidth={2.2} />
          </Animated.View>
        </Pressable>
      </Animated.View>

      {expanded ? (
        <View
          style={{
            paddingHorizontal: 14,
            paddingTop: 12,
            paddingBottom: 14,
            gap: 12,
            borderTopWidth: 1,
            borderTopColor: hexToRgba(palette.ink, 0.06),
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
            <Text style={{ color: palette.muted, ...typeStyle(12) }}>{run.event.replace(/_/g, " ")}</Text>
            {run.branch ? (
              <>
                <MetaDot />
                <Text numberOfLines={1} style={{ color: palette.muted, ...mono(11) }}>
                  {run.branch}
                </Text>
              </>
            ) : null}
            {run.sha ? (
              <>
                <MetaDot />
                <Text style={{ color: palette.muted, ...mono(11) }}>{run.sha.slice(0, 7)}</Text>
              </>
            ) : null}
            {run.actor ? (
              <>
                <MetaDot />
                <Text numberOfLines={1} style={{ color: palette.muted, ...typeStyle(12) }}>
                  {run.actor.login}
                </Text>
              </>
            ) : null}
          </View>

          {jobs === undefined && jobsLoading ? (
            <View style={{ paddingVertical: 18, alignItems: "center" }}>
              <ActivityIndicator size="small" color={palette.accent} />
            </View>
          ) : jobs && jobs.length > 0 ? (
            <View>
              {jobs.map((job) => (
                <JobRow key={job.id} job={job} now={now} />
              ))}
            </View>
          ) : (
            <Text style={{ color: palette.muted, ...typeStyle(12) }}>No jobs reported for this run.</Text>
          )}

          <View style={{ flexDirection: "row", gap: 8 }}>
            {live ? (
              <ActionChip label="Cancel" Icon={Ban} tone="danger" busy={busy} onPress={onCancel} />
            ) : (
              <ActionChip label="Re-run" Icon={RotateCcw} busy={busy} onPress={() => onRerun(false)} />
            )}
            {failed ? <ActionChip label="Re-run failed" Icon={Play} busy={busy} onPress={() => onRerun(true)} /> : null}
            <ActionChip
              label="GitHub"
              Icon={ExternalLink}
              onPress={() => void Linking.openURL(run.htmlUrl).catch(() => undefined)}
            />
          </View>
        </View>
      ) : null}
    </Animated.View>
  )
}

/* -------------------------------------------------------------- scope pill */

function ScopeToggle({ scope, branch, onChange }: { scope: Scope; branch: string; onChange(next: Scope): void }) {
  const { palette } = useAppTheme()

  return (
    <View
      style={{
        flexDirection: "row",
        gap: 2,
        borderRadius: 999,
        padding: 3,
        backgroundColor: hexToRgba(palette.ink, 0.09),
      }}
    >
      {(["branch", "all"] as const).map((value) => {
        const selected = scope === value
        return (
          <Pressable
            key={value}
            onPress={() => {
              if (selected) return
              void triggerHaptic("selection")
              onChange(value)
            }}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={value === "branch" ? `Runs on ${branch}` : "Runs on every branch"}
            style={({ pressed }) => ({
              minHeight: 32,
              justifyContent: "center",
              paddingHorizontal: 12,
              borderRadius: 999,
              // `surfaceRaised` is the card this sits on, so a selected pill in it is
              // invisible — the two labels read as one word. The ground goes darker and the
              // selected pill lighter, in opposite directions from the card.
              backgroundColor: selected ? palette.background : "transparent",
              opacity: pressed && !selected ? 0.6 : 1,
            })}
          >
            <Text style={{ color: selected ? palette.ink : palette.muted, ...typeStyle(11, { weight: "600" }) }}>
              {value === "branch" ? "Branch" : "All"}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/* ------------------------------------------------------------------- panel */

export function GitActionsPanel({
  owner,
  repo,
  branch,
  directory,
  active,
  bottomInset = 24,
  onSummary,
}: GitActionsPanelProps) {
  const { palette, isDark } = useAppTheme()
  const prefersReducedMotion = usePrefersReducedMotion()
  const showToast = useUIStore((state) => state.showToast)

  const [scope, setScope] = useState<Scope>(branch ? "branch" : "all")
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null)
  const [configured, setConfigured] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [expandedID, setExpandedID] = useState<number | null>(null)
  const [jobsByRun, setJobsByRun] = useState<Record<number, WorkflowJob[]>>({})
  const [jobsLoading, setJobsLoading] = useState(false)
  const [busyRunID, setBusyRunID] = useState<number | null>(null)

  const effectiveBranch = scope === "branch" ? branch : undefined
  const hasLive = (runs ?? []).some(isLive)
  const now = useTickingNow(active && hasLive)

  const resolveClient = useCallback(async () => {
    const { getMobileClient } = await import("@/lib/client")
    const client = await getMobileClient()
    if (!client) return null
    return directory ? client.withDirectory(directory) : client
  }, [directory])

  const loadRuns = useCallback(async () => {
    const client = await resolveClient()
    if (!client) {
      setError("No connection to the nikcli host.")
      return
    }
    try {
      const result = await client.listGithubWorkflowRuns(owner, repo, {
        ...(effectiveBranch ? { branch: effectiveBranch } : null),
        limit: RUN_LIMIT,
      })
      setRuns(result.runs)
      setConfigured(result.configured)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load workflow runs.")
    }
  }, [resolveClient, owner, repo, effectiveBranch])

  const loadJobs = useCallback(
    async (runID: number, options: { silent?: boolean } = {}) => {
      const client = await resolveClient()
      if (!client) return
      if (!options.silent) setJobsLoading(true)
      try {
        const jobs = await client.listGithubWorkflowRunJobs(owner, repo, runID)
        setJobsByRun((previous) => ({ ...previous, [runID]: jobs }))
      } catch {
        // The run row already carries the outcome. A failed job fetch degrades to "no jobs
        // reported" rather than replacing the whole panel with an error.
      } finally {
        if (!options.silent) setJobsLoading(false)
      }
    },
    [resolveClient, owner, repo],
  )

  // Changing the scope is a new query, not a refresh of the old one: drop the list so the
  // spinner shows instead of the previous branch's runs sitting under a new label.
  useEffect(() => {
    setRuns(null)
    setExpandedID(null)
  }, [effectiveBranch, owner, repo])

  /**
   * One poller. `expandedID` is read through a ref so opening a run refreshes its jobs on the
   * next tick without tearing the interval down and restarting the clock.
   */
  const expandedRef = useRef<number | null>(null)
  expandedRef.current = expandedID

  useEffect(() => {
    if (!active) return undefined
    let cancelled = false
    const tick = async () => {
      if (cancelled) return
      await loadRuns()
      const open = expandedRef.current
      if (!cancelled && open !== null) await loadJobs(open, { silent: true })
    }
    void tick()
    const id = setInterval(() => void tick(), hasLive ? POLL_LIVE_MS : POLL_IDLE_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [active, loadRuns, loadJobs, hasLive])

  async function handleRefresh() {
    setRefreshing(true)
    await loadRuns()
    if (expandedID !== null) await loadJobs(expandedID, { silent: true })
    setRefreshing(false)
  }

  function openRun(run: WorkflowRun) {
    const next = expandedID === run.id ? null : run.id
    if (!prefersReducedMotion) {
      LayoutAnimation.configureNext({
        duration: 260,
        create: { type: LayoutAnimation.Types.easeOut, property: LayoutAnimation.Properties.opacity, duration: 180 },
        update: { type: LayoutAnimation.Types.spring, springDamping: 1, duration: 260 },
        delete: { type: LayoutAnimation.Types.easeIn, property: LayoutAnimation.Properties.opacity, duration: 120 },
      })
    }
    void triggerHaptic("selection")
    setExpandedID(next)
    if (next !== null && jobsByRun[next] === undefined) void loadJobs(next)
  }

  async function mutateRun(run: WorkflowRun, operation: "rerun" | "rerun-failed" | "cancel") {
    const client = await resolveClient()
    if (!client) return
    setBusyRunID(run.id)
    try {
      if (operation === "cancel") await client.cancelGithubWorkflowRun(owner, repo, run.id)
      else await client.rerunGithubWorkflowRun(owner, repo, run.id, { failedOnly: operation === "rerun-failed" })
      void triggerHaptic("success")
      showToast({
        message: operation === "cancel" ? `Cancelling ${run.name} #${run.runNumber}` : `Re-running ${run.name}`,
        kind: "success",
      })
      // GitHub needs a beat before the run's new state is readable.
      setTimeout(() => void loadRuns(), 1200)
    } catch (cause) {
      void triggerHaptic("error")
      showToast({ message: cause instanceof Error ? cause.message : "GitHub rejected the request.", kind: "error" })
    } finally {
      setBusyRunID(null)
    }
  }

  const summary = useMemo(() => {
    const list = runs ?? []
    return {
      running: list.filter(isLive).length,
      failing: list.filter((run) => statusView(run.status, run.conclusion).tone === "failure").length,
      passing: list.filter((run) => run.conclusion === "success").length,
    }
  }, [runs])

  useEffect(() => {
    onSummary?.({ running: summary.running, failing: summary.failing })
  }, [onSummary, summary.running, summary.failing])

  const list = runs ?? []

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: bottomInset + 20 }}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void handleRefresh()} tintColor={palette.accent} />
      }
    >
      <View
        style={{
          borderRadius: 22,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: hexToRgba(palette.ink, isDark ? 0.09 : 0.08),
          backgroundColor: palette.surfaceRaised,
          padding: 14,
          gap: 12,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: palette.accentLight, ...caps(11) }}>Workflow health</Text>
            <Text style={{ marginTop: 3, color: palette.soft, ...typeStyle(12) }}>
              {summary.running > 0
                ? `${summary.running} running · ${summary.failing} failing · ${summary.passing} passing`
                : summary.failing > 0
                  ? `${summary.failing} failing · ${summary.passing} passing`
                  : list.length > 0
                    ? `${summary.passing} of the last ${list.length} passing`
                    : "Nothing recorded yet"}
            </Text>
          </View>
          {branch ? <ScopeToggle scope={scope} branch={branch} onChange={setScope} /> : null}
        </View>
        <HealthStrip runs={list} onSelect={openRun} />
      </View>

      {/*
        A failed poll on top of a good list is a hiccup, not a state: the list stays and the
        banner explains. Only a failure with nothing to show replaces the content.
      */}
      {error !== null && runs !== null ? (
        <ErrorBanner message={error} actionLabel="Retry" onAction={() => void handleRefresh()} />
      ) : null}

      {runs === null && error !== null ? (
        <EmptyState title="Actions unavailable" description={error} />
      ) : runs === null ? (
        <View style={{ paddingVertical: 48, alignItems: "center" }}>
          <ActivityIndicator color={palette.accent} />
        </View>
      ) : !configured ? (
        <EmptyState
          title="No workflows yet"
          description={`${owner}/${repo} has nothing under .github/workflows, so there is nothing to run.`}
        />
      ) : list.length === 0 ? (
        <EmptyState
          title={scope === "branch" ? "Nothing has run on this branch" : "No runs yet"}
          description={
            scope === "branch"
              ? `Push ${branch} or trigger a workflow and its runs appear here.`
              : "This repository has workflows but no recorded runs."
          }
        />
      ) : (
        list.map((run, index) => (
          <RunCard
            key={run.id}
            run={run}
            index={index}
            expanded={expandedID === run.id}
            jobs={jobsByRun[run.id]}
            jobsLoading={jobsLoading}
            busy={busyRunID === run.id}
            now={now}
            onToggle={() => openRun(run)}
            onRerun={(failedOnly) => void mutateRun(run, failedOnly ? "rerun-failed" : "rerun")}
            onCancel={() => void mutateRun(run, "cancel")}
          />
        ))
      )}
    </ScrollView>
  )
}
