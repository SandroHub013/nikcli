import { For, Show, createSignal } from "solid-js"
import { deferFromInput, deferPresets, formatDay, isPicked, localDay, type Picked } from "./answer"
import type { Decision } from "./state"
import type { SubmitControl } from "./card"
import { t } from "../i18n"

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
  picked: Picked
  note: string
  busy: boolean
  problem?: string
  /** Who the answer goes to, said under the buttons. */
  recipientHint: string
  now: Date
  onPick: (index: number) => void
  onNote: (note: string) => void
  /** The answer buttons, from `submitControl`. */
  control: SubmitControl
  /** A session picked in the inline "who receives" select. */
  onInline: (id: string | undefined) => void
  /** The main button: sends, choosing the inline pick first when needed. */
  onSubmit: () => void
  /** «Registra senza inviare»: writes the answer, leaves it queued. */
  onRecord: () => void
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
        {[props.decision.spec, t("decisions.from", props.decision.raisedBy), formatDay(props.decision.openedAt, props.now)].filter(Boolean).join(" · ")}
      </div>
      <Show when={props.decision.multi}>
        <div data-slot="decision-multi">{t("decisions.multi")}</div>
      </Show>
      <Show when={props.decision.context}>
        <p data-slot="decision-context">{props.decision.context}</p>
      </Show>
      <Show when={props.decision.unlocks}>
        <div data-slot="decision-unlocks">{t("decisions.unlocks", props.decision.unlocks ?? "")}</div>
      </Show>

      <Show when={props.decision.options.length > 0}>
        <div data-slot="decision-options" role={props.decision.multi ? "group" : "radiogroup"} aria-label={t("decisions.options")}>
          <For each={props.decision.options}>
            {(option, index) => (
              <button
                type="button"
                role={props.decision.multi ? "checkbox" : "radio"}
                aria-checked={isPicked(props.picked, index())}
                data-slot="decision-option"
                data-on={isPicked(props.picked, index()) ? "true" : undefined}
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
        placeholder={props.decision.options.length > 0 ? t("decisions.note.optional") : t("decisions.answer.yours")}
        value={props.note}
        onInput={(event) => props.onNote(event.currentTarget.value)}
        aria-label={props.decision.options.length > 0 ? t("decisions.note") : t("decisions.answer")}
      />

      <Show when={props.problem}>
        <div data-slot="decision-problem" role="alert">{props.problem}</div>
      </Show>

      <div data-slot="decision-actions">
        <button type="button" data-slot="decision-submit" disabled={props.control.disabled} onClick={() => props.onSubmit()}>
          {props.control.label}
        </button>
        <Show when={props.control.recordOnly}>
          <button type="button" data-slot="decision-ghost" data-action="record" disabled={props.busy} onClick={() => props.onRecord()}>
            {t("decisions.submit.record")}
          </button>
        </Show>
        <button
          type="button"
          data-slot="decision-ghost"
          disabled={props.busy}
          aria-expanded={deferring()}
          onClick={() => setDeferring(!deferring())}
        >
          {t("decisions.defer.open")}
        </button>
        <Show when={!props.control.options}>
          <span data-slot="decision-hint">{props.recipientHint}</span>
        </Show>
      </div>

      <Show when={props.control.options}>
        {(options) => (
          <label data-slot="recipient-inline-wrap">
            <span data-slot="decision-hint" data-tone="warn">{t("decisions.recipient.inline")}</span>
            <select data-slot="recipient-inline" onChange={(event) => props.onInline(event.currentTarget.value || undefined)}>
              <For each={options()}>
                {(option) => (
                  <option value={option.value} selected={option.selected}>
                    {option.label}
                  </option>
                )}
              </For>
            </select>
          </label>
        )}
      </Show>

      <Show when={deferring()}>
        <div data-slot="decision-defer" role="group" aria-label={t("decisions.defer.until")}>
          <span data-slot="decision-hint">{t("decisions.defer.back")}</span>
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
            aria-label={t("decisions.defer.date")}
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
            {t("decisions.defer")}
          </button>
        </div>
      </Show>
    </section>
  )
}
