import { For, Show } from "solid-js"
import { formatDay } from "./answer"
import { DesignPreview, resolvePreviewPath, shortenPath } from "./design-preview"
import type { DesignProposal } from "./state"
import type { DesignVariant } from "./log"
import { t } from "../i18n"

export function DesignCard(props: {
  proposal: DesignProposal
  picked: number | undefined
  note: string
  busy: boolean
  problem?: string
  submitLabel: string
  recipientHint: string
  now: Date
  projectRoot?: string
  onPick: (index: number) => void
  onNote: (note: string) => void
  onSubmit: () => void
  onOpenFullPreview?: (variant: DesignVariant) => void
  noteRef?: (element: HTMLTextAreaElement) => void
}) {
  return (
    <section data-slot="design-card" aria-label={`${props.proposal.k} ${props.proposal.title}`}>
      <header data-slot="design-head">
        <span data-slot="design-key">{props.proposal.k}</span>
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

      <Show when={props.proposal.context}>
        <p data-slot="design-context">{props.proposal.context}</p>
      </Show>

      <div data-slot="design-variants" role="radiogroup" aria-label={t("design.variants")}>
        <For each={props.proposal.variants}>
          {(variant, index) => (
            <div
              data-slot="design-variant-item"
              data-selected={props.picked === index() ? "true" : undefined}
            >
              <div data-slot="variant-head">
                <button
                  type="button"
                  role="radio"
                  aria-checked={props.picked === index()}
                  data-slot="variant-pick-button"
                  data-on={props.picked === index() ? "true" : undefined}
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
        <button
          type="button"
          data-slot="design-submit"
          disabled={props.busy}
          onClick={() => props.onSubmit()}
        >
          {props.submitLabel}
        </button>
        <span data-slot="design-hint">{props.recipientHint}</span>
      </div>
    </section>
  )
}
