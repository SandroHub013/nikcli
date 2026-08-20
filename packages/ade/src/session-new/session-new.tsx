/**
 * The screen that starts sessions: pick a shape, an agent, how many, and see
 * exactly what will launch before committing.
 *
 * Every rule lives in `preset.ts` and `launch.ts`; this file only renders them.
 * The WILL LAUNCH list is the point of the screen — it is the difference between
 * "four sessions" and "three agents and a shell", which the count alone hides.
 */
import { For, Show, createMemo, createResource, createSignal, type JSX } from "solid-js"
import { agentGlyph, agentLabel } from "./agents"
import { defaultAgentId, detectAgents, type AgentStatus } from "./availability"
import { getHost } from "../host/shell"
import { willLaunch } from "./launch"
import {
  MAX_SESSIONS,
  MIN_SESSIONS,
  PRESETS,
  clampSessions,
  configurationLabel,
  type PresetId,
} from "./preset"

export interface SessionNewProps {
  workspace: string
  path?: string
  onLaunch?: (input: { preset?: PresetId; agentId: string; count: number; task: string }) => void
  onClose?: () => void
}

const ROLE_SUFFIX: Record<string, string> = {
  reviewer: "revisiona",
  shell: "shell",
}

export function SessionNew(props: SessionNewProps): JSX.Element {
  const [preset, setPreset] = createSignal<PresetId | undefined>()
  // What is installed decides what can be selected: a list that offers an agent
  // this machine does not have guarantees a first launch that fails.
  const [agents] = createResource(async () => {
    const host = await getHost()
    return detectAgents(host?.probe)
  })
  const [chosen, setAgentId] = createSignal<string>()
  const agentId = createMemo(() => chosen() ?? defaultAgentId(agents() ?? []) ?? "")
  const [count, setCount] = createSignal(1)
  const [task, setTask] = createSignal("")

  // Choosing a preset is also choosing its session count; changing the count
  // afterwards is allowed and is what turns the footer into "Personalizzata".
  const choosePreset = (id: PresetId) => {
    const found = PRESETS.find((item) => item.id === id)
    setPreset(id)
    if (found) setCount(clampSessions(found.sessions))
  }

  const entries = createMemo(() => willLaunch({ preset: preset(), agentId: agentId(), count: count() }))
  const label = createMemo(() => configurationLabel({ preset: preset(), count: count() }))

  const launch = () =>
    props.onLaunch?.({ preset: preset(), agentId: agentId(), count: count(), task: task().trim() })

  return (
    <section data-component="session-new">
      <div data-slot="new-column">
        <header data-slot="new-bar">
          <div data-slot="new-heading">
            <h1 data-slot="new-title">Nuova sessione</h1>
            <span data-slot="new-where">
              <span data-slot="new-workspace">{props.workspace}</span>
              <Show when={props.path}>{(path) => <span data-slot="new-path">{path()}</span>}</Show>
            </span>
          </div>
          <div data-slot="new-spacer" />
          <Show when={props.onClose}>
            <button type="button" data-slot="new-close" onClick={() => props.onClose?.()} aria-label="Chiudi">
              ✕
            </button>
          </Show>
        </header>

        {/* The task is the whole point of the screen, so it comes first and is
            the only field big enough to invite typing. Everything below it is a
            refinement of a launch that already has a default. */}
        <div data-slot="new-compose">
          <textarea
            data-slot="new-task"
            rows={2}
            value={task()}
            onInput={(e) => setTask(e.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return
              event.preventDefault()
              launch()
            }}
            placeholder="Su cosa devono lavorare gli agenti?"
            spellcheck={false}
            autofocus
          />
          <div data-slot="new-compose-foot">
            <span data-slot="new-summary">
              {label()} · {count()} {count() === 1 ? "sessione" : "sessioni"} in {props.workspace}
            </span>
            <div data-slot="new-spacer" />
            <Show when={props.onClose}>
              <button type="button" data-slot="new-cancel" onClick={() => props.onClose?.()}>
                Annulla
              </button>
            </Show>
            {/* The button states the size of what it is about to start: pressing
                "Avvia" and getting four sessions is a surprise worth removing. */}
            <button type="button" data-slot="new-launch-btn" onClick={launch}>
              {count() === 1 ? "Avvia 1 sessione" : `Avvia ${count()} sessioni`}
              <span data-slot="new-launch-hint" aria-hidden="true">
                ⏎
              </span>
            </button>
          </div>
        </div>

        <div data-slot="new-body">
        <fieldset data-slot="new-section">
          <legend data-slot="new-legend">Preset</legend>
          <div data-slot="new-presets">
            <For each={PRESETS}>
              {(item) => (
                <button
                  type="button"
                  data-slot="new-preset"
                  data-active={preset() === item.id ? "true" : undefined}
                  onClick={() => choosePreset(item.id)}
                >
                  <span data-slot="new-preset-head">
                    <span data-slot="new-preset-label">{item.label}</span>
                    <span data-slot="new-preset-count">{item.sessions}</span>
                  </span>
                  <span data-slot="new-preset-desc">{item.description}</span>
                </button>
              )}
            </For>
          </div>
        </fieldset>

        <fieldset data-slot="new-section">
          <legend data-slot="new-legend">Agente</legend>
          <div data-slot="new-agents">
            <For each={agents() ?? []}>
              {(status: AgentStatus) => (
                <button
                  type="button"
                  data-slot="new-agent"
                  data-active={agentId() === status.agent.id ? "true" : undefined}
                  data-availability={status.availability}
                  disabled={status.availability === "assente"}
                  title={status.version ?? (status.availability === "assente" ? "non installato" : undefined)}
                  onClick={() => setAgentId(status.agent.id)}
                >
                  <span data-slot="new-agent-glyph" aria-hidden="true">
                    {status.agent.glyph}
                  </span>
                  <span data-slot="new-agent-label">{status.agent.label}</span>
                  <Show when={status.availability === "assente"}>
                    <span data-slot="new-agent-missing">non installato</span>
                  </Show>
                  <Show when={agentId() === status.agent.id}>
                    <span data-slot="new-agent-check" aria-hidden="true">
                      ✓
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </fieldset>

        <fieldset data-slot="new-section">
          <legend data-slot="new-legend">Quante</legend>
          <div data-slot="new-counts">
            <For each={Array.from({ length: MAX_SESSIONS - MIN_SESSIONS + 1 }, (_, i) => MIN_SESSIONS + i)}>
              {(value) => (
                <button
                  type="button"
                  data-slot="new-count"
                  data-active={count() === value ? "true" : undefined}
                  onClick={() => setCount(clampSessions(value))}
                >
                  {value}
                </button>
              )}
            </For>
            <span data-slot="new-counts-label">sessioni parallele</span>
          </div>
        </fieldset>

        <fieldset data-slot="new-section">
          <legend data-slot="new-legend">Partirà</legend>
          <div data-slot="new-launch">
            <For each={entries()}>
              {(entry) => (
                <div data-slot="new-launch-row" data-role={entry.role}>
                  <span data-slot="new-launch-index">{entry.index}</span>
                  <span data-slot="new-launch-glyph" aria-hidden="true">
                    {agentGlyph(entry.agentId)}
                  </span>
                  <span data-slot="new-launch-agent">{agentLabel(entry.agentId)}</span>
                  <Show when={ROLE_SUFFIX[entry.role]}>
                    {(suffix) => <span data-slot="new-launch-role">{suffix()}</span>}
                  </Show>
                </div>
              )}
            </For>
          </div>
        </fieldset>
        </div>
      </div>
    </section>
  )
}
