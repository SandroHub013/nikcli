import { For, Show, createSignal } from "solid-js"
import { deferFromInput, deferPresets, formatDay, localDay } from "./answer"
import type { Decision } from "./state"

/**
 * One open decision, answerable: context, the options as numbered choices, a
 * note, Registra and Rimanda. The window shows one of these at a time; the
 * panel shows the first open one this way and the rest as rows.
 *
 * Owns nothing but the deferral picker's open state: the pick and the note
 * belong to the caller, which keeps them while the user moves between
 * decisions and clears them once an answer is written.
 */
export function DecisionCard(props: {
  decision: Decision
  picked: number | undefined
  note: string
  busy: boolean
  problem?: string
  submitLabel: string
  /** Who the answer goes to, said under the buttons. */
  recipientHint: string
  now: Date
  onPick: (index: number) => void
  onNote: (note: string) => void
  onSubmit: () => void
  onDefer: (until: string) => void
  noteRef?: (element: HTMLTextAreaElement) => void
}) {
  const [deferring, setDeferring] = createSignal(false)
  const [customDay, setCustomDay] = createSignal("")
  const tomorrow = () => localDay(new Date(props.now.getFullYear(), props.now.getMonth(), props.now.getDate() + 1))

  return (
    <section data-slot="decision-card" aria-label={`${props.decision.k} ${props.decision.title}`}>
      <header data-slot="decision-head">
        <span data-slot="decision-key">{props.decision.k}</span>
        <h3 data-slot="decision-title">{props.decision.title}</h3>
      </header>
      <div data-slot="decision-meta">
        {[props.decision.spec, `da ${props.decision.raisedBy}`, formatDay(props.decision.openedAt, props.now)].filter(Boolean).join(" · ")}
      </div>
      <Show when={props.decision.context}>
        <p data-slot="decision-context">{props.decision.context}</p>
      </Show>
      <Show when={props.decision.unlocks}>
        <div data-slot="decision-unlocks">sblocca: {props.decision.unlocks}</div>
      </Show>

      <Show when={props.decision.options.length > 0}>
        <div data-slot="decision-options" role="radiogroup" aria-label="Opzioni">
          <For each={props.decision.options}>
            {(option, index) => (
              <button
                type="button"
                role="radio"
                aria-checked={props.picked === index()}
                data-slot="decision-option"
                data-on={props.picked === index() ? "true" : undefined}
                onClick={() => props.onPick(index())}
              >
                <span data-slot="decision-option-key" aria-hidden="true">{index() + 1}</span>
                <span data-slot="decision-option-text">
                  <b>{option.label}</b>
                  <Show when={option.detail}>
                    <small>{option.detail}</small>
                  </Show>
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <textarea
        ref={(element) => props.noteRef?.(element)}
        data-slot="decision-note"
        rows={2}
        placeholder={props.decision.options.length > 0 ? "Nota (facoltativa)" : "La tua risposta"}
        value={props.note}
        onInput={(event) => props.onNote(event.currentTarget.value)}
        aria-label={props.decision.options.length > 0 ? "Nota" : "Risposta"}
      />

      <Show when={props.problem}>
        <div data-slot="decision-problem" role="alert">{props.problem}</div>
      </Show>

      <div data-slot="decision-actions">
        <button type="button" data-slot="decision-submit" disabled={props.busy} onClick={() => props.onSubmit()}>
          {props.submitLabel}
        </button>
        <button
          type="button"
          data-slot="decision-ghost"
          disabled={props.busy}
          aria-expanded={deferring()}
          onClick={() => setDeferring(!deferring())}
        >
          Rimanda…
        </button>
        <span data-slot="decision-hint">{props.recipientHint}</span>
      </div>

      <Show when={deferring()}>
        <div data-slot="decision-defer" role="group" aria-label="Rimanda fino a">
          <span data-slot="decision-hint">Torna qui:</span>
          <For each={deferPresets(props.now)}>
            {(preset) => (
              <button type="button" data-slot="decision-chip" disabled={props.busy} onClick={() => props.onDefer(preset.until)}>
                {preset.label}
              </button>
            )}
          </For>
          <input
            type="date"
            data-slot="decision-date"
            min={tomorrow()}
            value={customDay()}
            onInput={(event) => setCustomDay(event.currentTarget.value)}
            aria-label="Data"
          />
          <button
            type="button"
            data-slot="decision-chip"
            disabled={props.busy || !deferFromInput(customDay(), props.now)}
            onClick={() => {
              const until = deferFromInput(customDay(), props.now)
              if (until) props.onDefer(until)
            }}
          >
            Rimanda
          </button>
        </div>
      </Show>
    </section>
  )
}
