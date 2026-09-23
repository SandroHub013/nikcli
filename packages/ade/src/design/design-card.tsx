import { For, Show } from "solid-js"
import { formatDay, isPicked, type Picked } from "./answer"
import { DesignPreview, resolvePreviewPath, sharedPreview, shortenPath } from "./design-preview"
import type { DesignProposal } from "./state"
import type { SubmitControl } from "./card"
import type { DesignVariant } from "./log"
import { t } from "../i18n"

export function DesignCard(props: {
  proposal: DesignProposal
  picked: Picked
  note: string
  busy: boolean
  problem?: string
  recipientHint: string
  now: Date
  projectRoot?: string
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
  /** «Altro giro»: the note, as a request for new variants. */
  onAgain: () => void
  onOpenFullPreview?: (variant: DesignVariant) => void
  noteRef?: (element: HTMLTextAreaElement) => void
}) {
  return (
    <section data-slot="design-card" aria-label={`${props.proposal.k} ${props.proposal.title}`}>
      <header data-slot="design-head">
        <span data-slot="design-key">{props.proposal.k}</span>
        <Show when={(props.proposal.round ?? 1) >= 2}>
          <span data-slot="design-round">{t("design.round", props.proposal.round ?? 1)}</span>
        </Show>
        <h3 data-slot="design-title">{props.proposal.title}</h3>
      </header>

      <div data-slot="design-meta">
        {[
          props.proposal.spec,
          t("decisions.from", props.proposal.raisedBy),
          formatDay(props.proposal.openedAt, props.now),
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>

      <Show when={props.proposal.multi}>
        <div data-slot="design-multi">{t("design.multi")}</div>
      </Show>

      <Show when={props.proposal.context}>
        <p data-slot="design-context">{props.proposal.context}</p>
      </Show>

      <Show when={sharedPreview(props.proposal.variants)}>
        <div data-slot="design-shared-preview" role="alert">{t("design.preview.shared")}</div>
      </Show>

      <div data-slot="design-variants" role={props.proposal.multi ? "group" : "radiogroup"} aria-label={t("design.variants")}>
        <For each={props.proposal.variants}>
          {(variant, index) => (
            <div
              data-slot="design-variant-item"
              data-selected={isPicked(props.picked, index()) ? "true" : undefined}
            >
              <div data-slot="variant-head">
                <button
                  type="button"
                  role={props.proposal.multi ? "checkbox" : "radio"}
                  aria-checked={isPicked(props.picked, index())}
                  data-slot="variant-pick-button"
                  data-on={isPicked(props.picked, index()) ? "true" : undefined}
                  onClick={() => props.onPick(index())}
                >
                  <span data-slot="variant-key" aria-hidden="true">{index() + 1}</span>
                  <b data-slot="variant-name">{variant.name}</b>
                </button>
              </div>

              <Show when={variant.description}>
                <p data-slot="variant-desc">{variant.description}</p>
              </Show>

              <Show when={variant.preview}>
                <div data-slot="variant-preview-wrap">
                  <DesignPreview
                    preview={variant.preview}
                    k={props.proposal.k}
                    name={variant.name}
                    projectRoot={props.projectRoot}
                    onToggleFullScreen={() => props.onOpenFullPreview?.(variant)}
                  />
                </div>
                <div
                  data-slot="variant-preview-source"
                  title={resolvePreviewPath(variant.preview, props.projectRoot)}
                >
                  <span data-slot="variant-preview-source-label">{t("design.preview.source")}:</span>
                  <span data-slot="variant-preview-source-path">
                    {shortenPath(resolvePreviewPath(variant.preview, props.projectRoot))}
                  </span>
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>

      <textarea
        ref={(element) => props.noteRef?.(element)}
        data-slot="design-note"
        rows={2}
        placeholder={t("decisions.note.optional")}
        value={props.note}
        onInput={(event) => props.onNote(event.currentTarget.value)}
        aria-label={t("decisions.note")}
      />

      <Show when={props.problem}>
        <div data-slot="design-problem" role="alert">{props.problem}</div>
      </Show>

      <div data-slot="design-actions">
        <button type="button" data-slot="design-submit" disabled={props.control.disabled} onClick={() => props.onSubmit()}>
          {props.control.label}
        </button>
        <button type="button" data-slot="design-ghost" data-action="again" disabled={props.control.disabled} onClick={() => props.onAgain()}>
          {t("design.again")}
        </button>
        <Show when={props.control.recordOnly}>
          <button type="button" data-slot="design-ghost" data-action="record" disabled={props.busy} onClick={() => props.onRecord()}>
            {t("design.submit.record")}
          </button>
        </Show>
        <Show when={!props.control.options}>
          <span data-slot="design-hint">{props.recipientHint}</span>
        </Show>
      </div>

      <Show when={props.control.options}>
        {(options) => (
          <label data-slot="recipient-inline-wrap">
            <span data-slot="design-hint" data-tone="warn">{t("design.recipient.inline")}</span>
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
    </section>
  )
}
