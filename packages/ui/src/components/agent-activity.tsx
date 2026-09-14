import { createMemo, createSignal, For, onCleanup, Show, createEffect, type ComponentProps } from "solid-js"
import { Icon } from "./icon"
import { getToolInfo } from "./message-part"

export type AgentActivityStatus = "pending" | "running" | "completed" | "error"

export type AgentActivityStep = {
  /** Stable identity — the tool call id. Drives enter/exit animations. */
  id: string
  tool: string
  input?: Record<string, unknown>
  status: AgentActivityStatus
}

export interface AgentActivityProps {
  steps: AgentActivityStep[]
  /** The agent is mid-turn. Drives the beacon, the travelling pulse and the timer. */
  active?: boolean
  /** Epoch ms the turn started; omit to hide the timer. */
  startedAt?: number
  /** How many steps stay expanded before older ones condense into dots. */
  expanded?: number
  class?: string
  classList?: ComponentProps<"div">["classList"]
}

const DEFAULT_EXPANDED = 7

function formatElapsed(ms: number) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms / 100) / 10).toFixed(1)}s`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`
}

/** Ticks while `active`, so the timer costs nothing once the turn ends. */
function useElapsed(active: () => boolean, startedAt: () => number | undefined) {
  const [now, setNow] = createSignal(Date.now())

  createEffect(() => {
    if (!active() || startedAt() === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 100)
    onCleanup(() => clearInterval(timer))
  })

  return createMemo(() => {
    const start = startedAt()
    if (start === undefined) return undefined
    return formatElapsed(Math.max(0, now() - start))
  })
}

function StepNode(props: { step: AgentActivityStep }) {
  const info = createMemo(() => getToolInfo(props.step.tool, props.step.input ?? {}))
  return (
    <span data-slot="agent-activity-node" title={[info().title, info().subtitle].filter(Boolean).join(" · ")}>
      <Icon name={info().icon} size="small" />
    </span>
  )
}

export function AgentActivity(props: AgentActivityProps) {
  const steps = () => props.steps
  const total = createMemo(() => steps().length)
  const done = createMemo(() => steps().filter((step) => step.status === "completed").length)
  const failed = createMemo(() => steps().some((step) => step.status === "error"))
  const running = createMemo(() => steps().find((step) => step.status === "running"))

  const limit = () => props.expanded ?? DEFAULT_EXPANDED
  // Older steps collapse into dots rather than scrolling, so the rail never
  // changes height and never overflows the dock it sits above.
  const condensed = createMemo(() => steps().slice(0, Math.max(0, total() - limit())))
  const visible = createMemo(() => steps().slice(Math.max(0, total() - limit())))

  const elapsed = useElapsed(
    () => !!props.active,
    () => props.startedAt,
  )

  const headline = createMemo(() => {
    const current = running()
    if (current) return getToolInfo(current.tool, current.input ?? {})
    return undefined
  })

  const state = createMemo(() => {
    if (failed()) return "error"
    if (props.active) return "active"
    return "done"
  })

  // A finished turn lingers briefly so the last step is readable, then gets out
  // of the way. A failed turn stays until the next one starts.
  const [lingering, setLingering] = createSignal(false)
  createEffect(() => {
    if (props.active) {
      setLingering(true)
      return
    }
    if (failed()) return
    const timer = setTimeout(() => setLingering(false), 4000)
    onCleanup(() => clearTimeout(timer))
  })

  return (
    <Show when={total() > 0 && (props.active || failed() || lingering())}>
      <div
        data-component="agent-activity"
        data-state={state()}
        classList={{
          ...(props.classList ?? {}),
          [props.class ?? ""]: !!props.class,
        }}
      >
        <div data-slot="agent-activity-head">
          <span data-slot="agent-activity-beacon" aria-hidden="true" />
          <span data-slot="agent-activity-label">
            <Show when={headline()} fallback={failed() ? "Stopped" : props.active ? "Thinking" : "Done"}>
              {(info) => (
                <>
                  {info().title}
                  <Show when={info().subtitle}>
                    <span data-slot="agent-activity-subtitle">{info().subtitle}</span>
                  </Show>
                </>
              )}
            </Show>
          </span>
          <span data-slot="agent-activity-meta">
            <span data-slot="agent-activity-count">
              {done()}/{total()}
            </span>
            <Show when={elapsed()}>{(value) => <span data-slot="agent-activity-time">{value()}</span>}</Show>
          </span>
        </div>

        <ol data-slot="agent-activity-rail" aria-label="Agent activity">
          <Show when={condensed().length > 0}>
            <li data-slot="agent-activity-condensed" title={`${condensed().length} earlier steps`}>
              <For each={condensed().slice(-6)}>
                {(step) => <span data-slot="agent-activity-dot" data-status={step.status} />}
              </For>
            </li>
          </Show>

          <For each={visible()}>
            {(step, index) => (
              <li data-slot="agent-activity-step" data-status={step.status}>
                <Show when={index() > 0 || condensed().length > 0}>
                  <span
                    data-slot="agent-activity-link"
                    data-flowing={step.status === "running" ? "true" : "false"}
                    aria-hidden="true"
                  />
                </Show>
                <StepNode step={step} />
              </li>
            )}
          </For>
        </ol>
      </div>
    </Show>
  )
}
