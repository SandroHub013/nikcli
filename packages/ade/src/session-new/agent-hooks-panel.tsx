import { For, Show, createSignal } from "solid-js"
import { HOOK_TARGETS, type HookStatus, type HookHost, setHook } from "./agent-hooks"

/**
 * The settings section for "let the CLI tell ADE which conversation it opened".
 *
 * This is the one feature in ADE that writes into files belonging to another
 * program, so the panel is the feature: nothing is installed until the user
 * presses the button, both paths that will change are printed in full before
 * they change, and removal is one press away and puts the file back exactly
 * as it was.
 *
 * What it buys is in `agent-link.ts`. The short version, and the version the
 * panel tells the user: codex has no way to be told which conversation to
 * open, so without this a restored codex pane can only ask for "the last
 * conversation" — which is the wrong one as soon as there are two panes.
 */

export interface AgentHooksSectionProps {
  /** The host, for the two commands that touch the files. */
  host: HookHost
  /** Current state per agent id, from the workbench. */
  states: Record<string, HookStatus>
  /** Called after a change, so the workbench can re-read. */
  onChanged: () => void
}

export function AgentHooksSection(props: AgentHooksSectionProps) {
  /* Which row has a command in flight, so its buttons can go quiet. */
  const [busy, setBusy] = createSignal<string | undefined>()
  const [failure, setFailure] = createSignal<string | undefined>()

  const apply = async (id: string, install: boolean) => {
    const target = HOOK_TARGETS.find((entry) => entry.id === id)
    if (!target) return
    setBusy(id)
    setFailure(undefined)
    try {
      await setHook(props.host, target, install)
      props.onChanged()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <>
      <div data-slot="section-head">
        <h3 data-slot="section-title" tabIndex={-1}>
          Ripresa delle sessioni
        </h3>
        <p data-slot="section-desc">
          Al riavvio ADE riapre le sessioni dov'erano. Per farlo deve sapere quale conversazione
          aveva ogni pannello: alcune CLI accettano un identificativo scelto da ADE, altre — codex
          fra queste — no, e possono solo dirlo loro. Qui ADE aggiunge una voce alla configurazione
          di quella CLI perché all'avvio di ogni sessione lo comunichi.
        </p>
      </div>

      <p data-slot="section-desc">
        Sono file che non appartengono ad ADE: vengono mostrati per intero qui sotto, le altre voci
        già presenti restano intatte, e «Rimuovi» rimette la configurazione com'era.
      </p>

      <ul data-slot="hook-list">
        <For each={HOOK_TARGETS}>
          {(target) => {
            const state = () => props.states[target.id]
            const working = () => busy() === target.id
            return (
              <li data-slot="hook-row">
                <div data-slot="hook-row-head">
                  <span data-slot="hook-name">{target.label}</span>
                  <span
                    data-slot="hook-state"
                    data-on={state()?.installed ? "true" : undefined}
                    data-broken={state()?.broken ? "true" : undefined}
                  >
                    {state()?.error
                      ? "non disponibile"
                      : state()?.installed
                        ? "attivo"
                        : state()?.broken
                          ? "da reinstallare"
                          : "non attivo"}
                  </span>
                </div>

                <Show when={state()?.broken}>
                  <p data-slot="hook-note">
                    C'è una voce di ADE nella configurazione, ma non corrisponde allo script sul
                    disco: la CLI sta eseguendo un hook che non fa nulla. Reinstalla per sistemarla.
                  </p>
                </Show>

                <Show when={state() && !state()?.error}>
                  <p data-slot="hook-paths">
                    <code>{state()?.configPath}</code>
                    <code>{state()?.scriptPath}</code>
                  </p>
                </Show>

                <Show when={state()?.error}>
                  <p data-slot="hook-note">{state()?.error}</p>
                </Show>

                <div data-slot="hook-actions">
                  <button
                    type="button"
                    data-slot="hook-action"
                    disabled={working() || Boolean(state()?.error)}
                    onClick={() => void apply(target.id, true)}
                  >
                    {state()?.installed ? "Reinstalla" : "Installa"}
                  </button>
                  <Show when={state()?.installed || state()?.broken}>
                    <button
                      type="button"
                      data-slot="hook-action"
                      disabled={working()}
                      onClick={() => void apply(target.id, false)}
                    >
                      Rimuovi
                    </button>
                  </Show>
                </div>
              </li>
            )
          }}
        </For>
      </ul>

      <Show when={failure()}>
        <p data-slot="hook-note">{failure()}</p>
      </Show>

      <p data-slot="section-desc">
        Lo script non fa niente fuori da ADE: esce alla prima variabile d'ambiente che non trova,
        quindi la stessa CLI avviata da un terminale qualunque si comporta esattamente come prima.
      </p>
    </>
  )
}
