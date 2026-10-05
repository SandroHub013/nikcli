import { createSignal, onMount, For, Show, type JSX } from "solid-js"
import { HowItWorks } from "@nikcli-ai/voice"
import { providerState, type ProviderState } from "../bots/providers"
import { RUNNERS, runnerAccount, type Runner } from "../bots/runners"
import { MAX_PARALLEL_TURNS } from "../bots/terms"
import { t } from "../i18n"

export interface AccountSectionProps {
  /** Opens the runner's sign-in in a terminal pane. Absent: no button. */
  onLogin?: (runner: Runner) => void
  /** Injected state reader, for tests with a fake host. */
  fetchState?: (runner: Runner) => Promise<ProviderState>
}

export type ProviderStatusKind = "connected" | "not-connected" | "not-installed" | "checking" | "unverified"

export function resolveStatusKind(state: ProviderState | undefined, checking: boolean): ProviderStatusKind {
  if (checking || !state) return "checking"
  if (!state.installed) return "not-installed"
  if (state.login.state === "in") return "connected"
  if (state.login.state === "out") return "not-connected"
  return "unverified"
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

  const readState = props.fetchState ?? providerState

  const check = () => {
    if (checking()) return
    setChecking(true)
    setStates({})
    setConfirming(undefined)
    void Promise.all(
      RUNNERS.map((runner) =>
        readState(runner).then((state) => setStates((prev) => ({ ...prev, [runner.id]: state }))),
      ),
    ).finally(() => setChecking(false))
  }
  onMount(check)

  return (
    <>
      <div data-slot="section-head">
        <h3 data-slot="section-title" tabIndex={-1}>
          {t("settings.tab.account")}
        </h3>
        <p data-slot="section-desc">{t("settings.account.intro")}</p>
      </div>

      <HowItWorks title={t("settings.howItWorks")}>
        <p>{t("settings.providers.desc1")}</p>
        <p>
          {t("settings.providers.desc2Before", MAX_PARALLEL_TURNS)}
          <code>{"codex login --with-api-key"}</code>
          {t("settings.providers.desc2After")}
        </p>
      </HowItWorks>

      <div data-slot="account-cards">
        <For each={RUNNERS}>
          {(runner) => {
            const state = () => states()[runner.id]
            const kind = () => resolveStatusKind(state(), checking())
            const isConfirming = () => confirming() === runner.id

            return (
              <div
                data-slot="provider-card"
                data-runner={runner.id}
                data-state={kind()}
              >
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

                <Show when={state()?.login.detail}>
                  <span data-slot="settings-meta">{state()!.login.detail}</span>
                </Show>

                <div data-slot="provider-actions">
                  <Show when={props.onLogin && state()?.installed && runner.login.length > 0}>
                    <Show
                      when={state()?.login.state === "in"}
                      fallback={
                        <button
                          type="button"
                          data-slot="settings-choice"
                          onClick={() => props.onLogin?.(runner)}
                          title={`${runner.command} ${runner.login.join(" ")}`}
                        >
                          {t("settings.providers.login")}
                        </button>
                      }
                    >
                      <Show
                        when={isConfirming()}
                        fallback={
                          <button
                            type="button"
                            data-slot="settings-choice"
                            data-action="switch"
                            onClick={() => setConfirming(runner.id)}
                          >
                            {t("settings.providers.switchAccount")}
                          </button>
                        }
                      >
                        <div data-slot="switch-confirm">
                          <p data-slot="switch-prompt">
                            {t("settings.providers.switchPrompt", runner.label)}
                          </p>
                          <div data-slot="switch-buttons">
                            <button
                              type="button"
                              data-slot="switch-continue"
                              onClick={() => {
                                setConfirming(undefined)
                                props.onLogin?.(runner)
                              }}
                            >
                              {t("settings.providers.switchContinue")}
                            </button>
                            <button
                              type="button"
                              data-slot="switch-cancel"
                              onClick={() => setConfirming(undefined)}
                            >
                              {t("settings.providers.switchCancel")}
                            </button>
                          </div>
                        </div>
                      </Show>
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
