import { createEffect, createSignal, onCleanup, onMount, For, Show, type JSX } from "solid-js"
import { HowItWorks } from "@nikcli-ai/voice"
import { providerState, type ProviderState } from "../bots/providers"
import { RUNNERS, runnerAccount, type Runner } from "../bots/runners"
import { MAX_PARALLEL_TURNS } from "../bots/terms"
import { t } from "../i18n"

export interface AccountSectionProps {
  /** Opens the runner's sign-in in a terminal pane. Absent: no button. */
  onLogin?: (runner: Runner) => void
}

export type ProviderStatusKind = "connected" | "not-connected" | "not-installed" | "checking" | "unverified"

export function resolveStatusKind(state: ProviderState | undefined): ProviderStatusKind {
  if (!state) return "checking"
  if (!state.installed) return "not-installed"
  if (state.login.state === "in") return "connected"
  if (state.login.state === "out") return "not-connected"
  return "unverified"
}

/**
 * Whether a sign-in needs the user's word first. «Collegato» has an account to
 * lose; «Da verificare» may have one too, since the CLI could not say, and the
 * sign-in that opens is a real one that finishes by itself. «Non collegato» has
 * nothing to lose.
 */
export function needsConfirmation(kind: ProviderStatusKind): boolean {
  return kind === "connected" || kind === "unverified"
}

export function statusLabel(kind: ProviderStatusKind): string {
  switch (kind) {
    case "connected":
      return t("settings.providers.connected")
    case "not-connected":
      return t("settings.providers.notConnected")
    case "not-installed":
      return t("settings.providers.notInstalled")
    case "checking":
      return t("settings.providers.checking")
    case "unverified":
      return t("settings.providers.unverified")
  }
}

/**
 * The programs a bot can run on, side-by-side cards with connection status (S4).
 *
 * Each card shows one runner, its login state, and a single action button.
 * Switching accounts asks confirmation before opening the real sign-in.
 * Explanations of credentials and subscriptions are collapsed in «Come funziona».
 */
export function AccountSection(props: AccountSectionProps): JSX.Element {
  const [states, setStates] = createSignal<Record<string, ProviderState>>({})
  const [checking, setChecking] = createSignal(false)
  const [confirming, setConfirming] = createSignal<string | undefined>()

  const check = () => {
    if (checking()) return
    setChecking(true)
    setStates({})
    setConfirming(undefined)
    void Promise.all(
      RUNNERS.map((runner) =>
        providerState(runner).then((state) => setStates((prev) => ({ ...prev, [runner.id]: state }))),
      ),
    ).finally(() => setChecking(false))
  }
  onMount(check)

  /* The focus follows the question: onto «Annulla» when it opens, back onto the button when it closes. */
  const cardPart = (runner: string | undefined, part: string) =>
    runner
      ? document.querySelector<HTMLElement>(`[data-slot="provider-card"][data-runner="${runner}"] ${part}`)
      : null
  const ask = (runner: string) => {
    setConfirming(runner)
    queueMicrotask(() => cardPart(runner, '[data-slot="switch-cancel"]')?.focus())
  }
  const closeQuestion = () => {
    const runner = confirming()
    setConfirming(undefined)
    queueMicrotask(() => cardPart(runner, "[data-action]")?.focus())
  }

  /*
   * Esc answers the question and nothing more: the sheet closes on an Escape
   * that reaches the document in the bubbling phase, so this one listens in the
   * capture phase and claims it first, the way the voice panel does for its own
   * Escapes (`panelListensEarly`). Only while a question is standing.
   */
  createEffect(() => {
    if (confirming() === undefined) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      closeQuestion()
    }
    document.addEventListener("keydown", onKey, true)
    onCleanup(() => document.removeEventListener("keydown", onKey, true))
  })

  return (
    <>
      <div data-slot="section-head">
        <p data-slot="section-desc">{t("settings.account.intro")}</p>
      </div>

      <HowItWorks title={t("settings.howItWorks")}>
        <p data-slot="section-desc">{t("settings.providers.desc1")}</p>
        <p data-slot="section-desc">
          {t("settings.providers.desc2Before", MAX_PARALLEL_TURNS)}
          <code>{"codex login --with-api-key"}</code>
          {t("settings.providers.desc2After")}
        </p>
      </HowItWorks>

      <div data-slot="account-cards">
        <For each={RUNNERS}>
          {(runner) => {
            const state = () => states()[runner.id]
            const kind = () => resolveStatusKind(state())
            const isConfirming = () => confirming() === runner.id

            return (
              <div data-slot="provider-card" data-runner={runner.id} data-state={kind()}>
                <div data-slot="provider-head">
                  <span data-slot="provider-name">{runner.label}</span>
                  <span
                    data-slot="provider-badge"
                    data-state={kind()}
                    title={state()?.login.detail ?? statusLabel(kind())}
                  >
                    <span data-slot="status-dot" />
                    <span data-slot="status-label">{statusLabel(kind())}</span>
                  </span>
                </div>

                <p data-slot="provider-desc">{runnerAccount(runner.id)}</p>

                <div data-slot="provider-actions">
                  <Show when={props.onLogin && state()?.installed && runner.login.length > 0}>
                    <Show
                      when={isConfirming()}
                      fallback={
                        <button
                          type="button"
                          data-slot="settings-choice"
                          data-action={kind() === "connected" ? "switch" : "login"}
                          onClick={() => (needsConfirmation(kind()) ? ask(runner.id) : props.onLogin?.(runner))}
                          title={`${runner.command} ${runner.login.join(" ")}`}
                        >
                          {kind() === "connected"
                            ? t("settings.providers.switchAccount")
                            : t("settings.providers.login")}
                        </button>
                      }
                    >
                      <div data-slot="switch-confirm" role="group" aria-labelledby={`switch-prompt-${runner.id}`}>
                        <p data-slot="switch-prompt" id={`switch-prompt-${runner.id}`}>
                          {t("settings.providers.switchPrompt", runner.label)}
                        </p>
                        <div data-slot="switch-buttons">
                          <button
                            type="button"
                            data-slot="switch-continue"
                            onClick={(event) => {
                              /*
                               * The question stands where the button was pressed, so the second
                               * press of a double click lands on «Continua». It is not an answer.
                               */
                              if (event.detail > 1) return
                              setConfirming(undefined)
                              props.onLogin?.(runner)
                            }}
                          >
                            {t("settings.providers.switchContinue")}
                          </button>
                          <button type="button" data-slot="switch-cancel" onClick={() => closeQuestion()}>
                            {t("settings.providers.switchCancel")}
                          </button>
                        </div>
                      </div>
                    </Show>
                  </Show>
                </div>
              </div>
            )
          }}
        </For>
      </div>

      <div data-slot="settings-choices">
        <button type="button" data-slot="settings-choice" disabled={checking()} onClick={check}>
          {checking() ? t("settings.providers.checking") : t("settings.providers.checkAgain")}
        </button>
      </div>
    </>
  )
}
