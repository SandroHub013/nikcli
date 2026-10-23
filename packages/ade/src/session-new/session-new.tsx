/**
 * The screen that starts sessions: pick a shape, an agent, how many, and see
 * exactly what will launch before committing.
 *
 * Every rule lives in `preset.ts` and `launch.ts`; this file only renders them.
 * The WILL LAUNCH list is the point of the screen — it is the difference between
 * "four sessions" and "three agents and a shell", which the count alone hides.
 */
import { For, Show, createMemo, createResource, createSignal, type JSX } from "solid-js"
import { agentLabel } from "./agents"
import { AgentMark } from "./agent-mark"
import { defaultAgentId, recheckAgents, type AgentStatus } from "./availability"
import { InstallPanel } from "./install-panel"
import { installOs, type InstallOs } from "./install"
import { getHost, type Host } from "../host/shell"
import { openExternally } from "../browser/host-bridge"
import { willLaunch } from "./launch"
import { MAX_SESSIONS, MIN_SESSIONS, clampSessions, type PresetId } from "./preset"
import { t } from "../i18n"

export interface SessionNewProps {
  workspace: string
  path?: string
  onLaunch?: (input: { preset?: PresetId; agentId: string; count: number; task: string }) => void
  /** Opens a terminal pane and types the install line into it, for the agent whose card was opened. */
  onInstall?: (input: { agentId: string; label: string; line: string }) => void
  onClose?: () => void
  /** The host, when it is not the real one: tests. */
  loadHost?: () => Promise<Host | undefined>
  /** Opens a project page in the system browser; tests pass their own. */
  openPage?: (url: string) => void
  /** The system the commands are chosen for; the one ADE runs on unless a test says otherwise. */
  os?: InstallOs
}

const ROLE_SUFFIX: Readonly<Record<string, string>> = {
  get reviewer() {
    return t("new.role.reviewer")
  },
  shell: "shell",
}

export function SessionNew(props: SessionNewProps): JSX.Element {
  // What is installed decides what can be selected: a list that offers an agent
  // this machine does not have guarantees a first launch that fails.
  const loadHost = () => (props.loadHost ?? getHost)()
  const os = () => props.os ?? installOs()
  // On Windows the PATH is reread first, so an agent installed since ADE started is seen without asking: it is a
  // registry read there, and a login shell elsewhere, which is left to the panel's «Ricontrolla».
  const [loaded, { mutate }] = createResource(async () => {
    const host = await loadHost()
    return { host, statuses: await recheckAgents(host, os() === "windows") }
  })
  const agents = () => loaded()?.statuses
  const [chosen, setAgentId] = createSignal<string>()
  // The missing agent whose install panel is open.
  const [installing, setInstalling] = createSignal<string>()
  const installingStatus = () => (agents() ?? []).find((status) => status.agent.id === installing())
  const recheck = async (id: string) => {
    const host = await loadHost()
    const statuses = await recheckAgents(host)
    mutate({ host, statuses })
    return statuses.find((status) => status.agent.id === id)
  }
  const agentId = createMemo(() => chosen() ?? defaultAgentId(agents() ?? []) ?? "")
  const [count, setCount] = createSignal(1)

  const entries = createMemo(() => willLaunch({ agentId: agentId(), count: count() }))

  const launch = () => props.onLaunch?.({ agentId: agentId(), count: count(), task: "" })

  return (
    <section
      data-component="session-new"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && (event.target as HTMLElement)?.tagName !== "BUTTON") {
          event.preventDefault()
          launch()
        }
        if (event.key === "Escape") {
          event.preventDefault()
          props.onClose?.()
        }
      }}
    >
      <div data-slot="new-column">
        <header data-slot="new-bar">
          <div data-slot="new-heading">
            <h1 data-slot="new-title">{t("new.title")}</h1>
            <span data-slot="new-where">
              <span data-slot="new-workspace">{props.workspace}</span>
              <Show when={props.path}>{(path) => <span data-slot="new-path">{path()}</span>}</Show>
            </span>
          </div>
          <div data-slot="new-spacer" />
          <div data-slot="new-actions">
            <Show when={props.onClose}>
              <button type="button" data-slot="new-cancel" onClick={() => props.onClose?.()}>
                {t("new.cancel")}
              </button>
            </Show>
            <button type="button" data-slot="new-launch-btn" onClick={launch}>
              {t("new.launch", count())}
              <span data-slot="new-launch-hint" aria-hidden="true">
                ⏎
              </span>
            </button>
            <Show when={props.onClose}>
              <button type="button" data-slot="new-close" onClick={() => props.onClose?.()} aria-label={t("new.close")}>
                ✕
              </button>
            </Show>
          </div>
        </header>

        <div data-slot="new-body">
          <fieldset data-slot="new-section">
            <legend data-slot="new-legend">{t("new.agent")}</legend>
            <div data-slot="new-agents">
              <For each={agents() ?? []}>
                {(status: AgentStatus) => {
                  const isSelected = () => agentId() === status.agent.id
                  const isAbsent = () => status.availability === "assente"

                  return (
                    <button
                      type="button"
                      data-slot="new-agent"
                      data-agent-id={status.agent.id}
                      data-active={isSelected() ? "true" : undefined}
                      data-availability={status.availability}
                      data-installing={installing() === status.agent.id ? "true" : undefined}
                      title={status.path ?? (isAbsent() ? t("install.cardHint") : undefined)}
                      onClick={() => (isAbsent() ? setInstalling(status.agent.id) : setAgentId(status.agent.id))}
                    >
                      <span data-slot="new-agent-glyph" aria-hidden="true">
                        <AgentMark id={status.agent.id} size={22} colored />
                      </span>
                      <div data-slot="new-agent-body">
                        <span data-slot="new-agent-label">{status.agent.label}</span>
                      </div>
                      <div data-slot="new-agent-badge-slot">
                        <Show
                          when={isAbsent()}
                          fallback={
                            <span
                              data-slot="new-agent-check"
                              data-visible={isSelected() ? "true" : undefined}
                              aria-hidden={!isSelected()}
                            >
                              ✓
                            </span>
                          }
                        >
                          <span data-slot="new-agent-missing">{t("new.missing")}</span>
                        </Show>
                      </div>
                    </button>
                  )
                }}
              </For>
            </div>
            {/* Keyed by the agent's id, not by its status: a recheck that finds nothing replaces the status, and the
                panel must keep the «ancora non lo trovo» it is about to show. */}
            <Show when={installingStatus()?.availability === "assente" ? installing() : undefined} keyed>
              {(id) => (
                <InstallPanel
                  status={installingStatus()!}
                  os={os()}
                  recheck={() => recheck(id)}
                  onClose={() => setInstalling(undefined)}
                  onFound={() => {
                    setAgentId(id)
                    setInstalling(undefined)
                  }}
                  onOpenPage={(url) => (props.openPage ?? ((page) => void openExternally(page)))(url)}
                  {...(props.onInstall ? { onRun: props.onInstall } : {})}
                  {...(loaded()?.host?.probe ? { probe: loaded()!.host!.probe } : {})}
                />
              )}
            </Show>
          </fieldset>

          <fieldset data-slot="new-section">
            <legend data-slot="new-legend">{t("new.count")}</legend>
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
              <span data-slot="new-counts-label">{t("new.count.label")}</span>
            </div>
          </fieldset>

          <fieldset data-slot="new-section">
            <legend data-slot="new-legend">{t("new.preview")}</legend>
            <div data-slot="new-launch">
              <For each={entries()}>
                {(entry) => (
                  <div data-slot="new-launch-row" data-role={entry.role}>
                    <span data-slot="new-launch-index">{entry.index}</span>
                    <span data-slot="new-launch-glyph" data-agent-id={entry.agentId} aria-hidden="true">
                      <AgentMark id={entry.agentId} size={15} colored />
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

          <footer data-slot="new-foot">
            <span data-slot="new-summary">{t("new.summary", count(), agentLabel(agentId()), props.workspace)}</span>
            <div data-slot="new-spacer" />
            <Show when={props.onClose}>
              <button type="button" data-slot="new-cancel" onClick={() => props.onClose?.()}>
                {t("new.cancel")}
              </button>
            </Show>
            <button type="button" data-slot="new-launch-btn" onClick={launch}>
              {t("new.launch", count())}
              <span data-slot="new-launch-hint" aria-hidden="true">
                ⏎
              </span>
            </button>
          </footer>
        </div>
      </div>
    </section>
  )
}
