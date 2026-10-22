/**
 * The panel a missing agent's card opens: what to run, where it comes from, and the two buttons that matter —
 * run it in a terminal the user can see, and look again once it has finished.
 *
 * The rules live in `install.ts` and `availability.ts`; this file only draws them. Nothing here runs a process:
 * «Installa» hands the line to the host through `onRun`, which opens a terminal pane, and «Ricontrolla» hands the
 * lookup to `recheck`.
 */
import { Show, createResource, createSignal, type JSX } from "solid-js"
import { t } from "../i18n"
import type { AgentStatus, Probe } from "./availability"
import {
  PREREQUISITES,
  commandFor,
  installFor,
  missingPrerequisite,
  terminalLine,
  type InstallCaveat,
  type InstallOs,
} from "./install"

export interface InstallPanelProps {
  status: AgentStatus
  os: InstallOs
  /** Looks `npm`, `winget` or `brew` up; absent in the browser, where nothing is claimed missing. */
  probe?: Probe
  /** Looks the agents up again, after the PATH was reread; the agent's own status afterwards. */
  recheck: () => Promise<AgentStatus | undefined>
  /** Opens a terminal pane and types `line` into it. Absent: there is nowhere to run it. */
  onRun?: (input: { agentId: string; label: string; line: string }) => void
  onOpenPage: (url: string) => void
  /** The agent is installed now: the form selects it. */
  onFound: () => void
  onClose: () => void
}

const withoutScheme = (url: string) => url.replace(/^https?:\/\//, "")

function caveatText(caveat: InstallCaveat, label: string): string {
  switch (caveat.kind) {
    case "binary":
      return t("install.caveat.binary", label, caveat.provides)
    case "subscription":
      return t("install.caveat.subscription")
    case "wsl":
      return t("install.caveat.wsl")
  }
}

export function InstallPanel(props: InstallPanelProps): JSX.Element {
  const entry = () => installFor(props.status.agent.id)
  const command = () => commandFor(entry(), props.os)
  const label = () => props.status.agent.label

  const [missing] = createResource(command, (current) => missingPrerequisite(current, props.probe))
  const [outcome, setOutcome] = createSignal<"idle" | "checking" | "found" | "notFound">("idle")
  const [copied, setCopied] = createSignal(false)

  const recheck = async () => {
    setOutcome("checking")
    const next = await props.recheck().catch(() => undefined)
    if (next && next.availability !== "assente") {
      setOutcome("found")
      props.onFound()
    } else setOutcome("notFound")
  }

  const copy = async () => {
    const current = command()
    if (!current) return
    // Loaded when asked: the terminal registry brings the whole emulator with it, and the form needs none of it to draw.
    const { copyToClipboard } = await import("../terminal/registry")
    if (await copyToClipboard(current.line)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }
  }

  return (
    <section data-slot="install" data-agent-id={props.status.agent.id} aria-label={t("install.title", label())}>
      <header data-slot="install-head">
        <h2 data-slot="install-title">{t("install.title", label())}</h2>
        <button type="button" data-slot="install-close" onClick={() => props.onClose()} aria-label={t("install.close")}>
          ✕
        </button>
      </header>

      <Show when={entry()?.caveat}>{(caveat) => <p data-slot="install-caveat">{caveatText(caveat(), label())}</p>}</Show>

      <Show
        when={command()}
        fallback={
          <p data-slot="install-none">{t("install.noCommand")}</p>
        }
      >
        {(current) => (
          <>
            <div data-slot="install-command">
              <span data-slot="install-command-label">{t("install.command")}</span>
              <code data-slot="install-line">{current().line}</code>
              <button type="button" data-slot="install-copy" onClick={() => void copy()}>
                {copied() ? t("install.copied") : t("install.copy")}
              </button>
            </div>
            <Show when={current().adapted}>
              {(adapted) => <p data-slot="install-caveat">{t(`install.caveat.${adapted()}` as const)}</p>}
            </Show>
            <Show when={missing()}>
              {(program) => (
                <p data-slot="install-requires">
                  {t("install.requires", program())}{" "}
                  <button
                    type="button"
                    data-slot="install-link"
                    onClick={() => props.onOpenPage(PREREQUISITES[program()].page)}
                  >
                    {t("install.requiresPage", program())}
                  </button>
                </p>
              )}
            </Show>
          </>
        )}
      </Show>

      <div data-slot="install-actions">
        <Show when={command() && props.onRun}>
          <button
            type="button"
            data-slot="install-run"
            title={t("install.runHint")}
            onClick={() => {
              const current = command()
              if (current)
                props.onRun?.({ agentId: props.status.agent.id, label: label(), line: terminalLine(current) })
            }}
          >
            {t("install.run")}
          </button>
        </Show>
        <button type="button" data-slot="install-recheck" disabled={outcome() === "checking"} onClick={() => void recheck()}>
          {outcome() === "checking" ? t("install.rechecking") : t("install.recheck")}
        </button>
        <Show when={entry()}>
          {(current) => (
            <button type="button" data-slot="install-page" onClick={() => props.onOpenPage(current().page)}>
              {t("install.page")}
            </button>
          )}
        </Show>
      </div>

      <p data-slot="install-outcome" role="status" aria-live="polite">
        <Show when={outcome() === "found"}>{t("install.found", label())}</Show>
        <Show when={outcome() === "notFound"}>{t("install.notFound")}</Show>
      </p>

      <Show when={entry()}>
        {(current) => (
          <p data-slot="install-source">{t("install.source", withoutScheme(current().source), current().checked)}</p>
        )}
      </Show>
    </section>
  )
}
