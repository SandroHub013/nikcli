import { For, Show, createMemo, createSignal } from "solid-js"
import { formatDay, formatMoment } from "./answer"
import { DesignCard } from "./design-card"
import { DesignPreview, resolvePreviewPath, shortenPath } from "./design-preview"
import { recipientHint } from "./design-sheet"
import { recipientChange, recipientOptions, type RecipientStatus } from "./delivery"
import { projectRootFromRegisterPath, type DesignHub } from "./hub"
import { bucketProposals, describeProblems, type DesignProposal } from "./state"
import "./design.css"
import { t } from "../i18n"

export function DesignPane(props: {
  hub: DesignHub
  focused: boolean
  onFocus?: () => void
  onClose?: () => void
  onExpand?: () => void
}) {
  const root = () => props.hub.projectRoot?.() ?? projectRootFromRegisterPath(props.hub.register.path())
  const state = () => props.hub.register.state()
  const buckets = createMemo(() => bucketProposals(state()?.proposals ?? []))
  const [expanded, setExpanded] = createSignal<string>()
  const [showClosed, setShowClosed] = createSignal(false)
  const now = () => new Date()

  const active = () =>
    expanded() && buckets().forYou.some((d) => d.k === expanded())
      ? expanded()
      : buckets().forYou[0]?.k

  const problems = createMemo(() => {
    const loaded = props.hub.register.loaded()
    return loaded ? describeProblems(loaded.problems, state()?.rejected ?? []) : []
  })

  const card = (proposal: DesignProposal) => (
    <DesignCard
      proposal={proposal}
      picked={props.hub.draft(proposal.k).picked}
      note={props.hub.draft(proposal.k).note}
      busy={props.hub.busy(proposal.k)}
      problem={props.hub.problem(proposal.k)}
      submitLabel={t("design.submit")}
      recipientHint={recipientHint(props.hub.recipient())}
      now={now()}
      projectRoot={root()}
      onPick={(picked) => props.hub.setDraft(proposal.k, { ...props.hub.draft(proposal.k), picked })}
      onNote={(text) => props.hub.setDraft(proposal.k, { ...props.hub.draft(proposal.k), note: text })}
      onSubmit={() => void props.hub.answer(proposal)}
      onOpenFullPreview={(variant) => props.hub.openFullPreview(variant, proposal.title)}
    />
  )

  return (
    <article
      data-component="design-pane"
      data-focused={props.focused ? "true" : undefined}
      onFocusIn={() => props.onFocus?.()}
      onPointerDown={() => props.onFocus?.()}
    >
      <header data-slot="pane-header">
        <span data-slot="pane-identity" aria-hidden="true">
          <DesignGlyph />
        </span>
        <h2 data-slot="pane-title" title={props.hub.register.path()}>
          {t("design.title")}
          {buckets().forYou.length > 0 ? ` · ${t("design.openCount", buckets().forYou.length)}` : ""}
        </h2>
        <div data-slot="pane-actions">
          <button type="button" data-slot="pane-action" onClick={() => props.onExpand?.()} aria-label={t("pane.expand")}>
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M1 4.5V1h3.5M11 7.5V11H7.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
          <button type="button" data-slot="pane-action" onClick={() => props.onClose?.()} aria-label={t("pane.close")}>
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </header>

      <div data-slot="design-body">
        <Show when={!props.hub.register.path()}>
          <div data-slot="sheet-empty">
            <b>{t("design.noProject")}</b>
            <span>{t("design.noProject.hint")}</span>
          </div>
        </Show>

        <Show when={props.hub.register.error()}>
          <div data-slot="design-problem" role="alert">{t("design.unreadable", String(props.hub.register.error()))}</div>
        </Show>

        <Show when={problems().length > 0}>
          <details data-slot="design-problems">
            <summary>{t("design.ignored", problems().length)}</summary>
            <ul>
              <For each={problems()}>{(line) => <li>{line}</li>}</For>
            </ul>
          </details>
        </Show>

        <Show when={props.hub.register.path()}>
          <DesignRecipientPicker
            hub={props.hub}
            queued={buckets().answered.filter((proposal) => props.hub.delivery(proposal).state === "in coda").length}
          />

          <h4 data-slot="design-section">{t("design.section.open")}</h4>
          <Show when={buckets().forYou.length > 0} fallback={<p data-slot="design-none">{t("design.none")}</p>}>
            <div data-slot="design-list">
              <For each={buckets().forYou}>
                {(proposal) => (
                  <Show
                    when={active() === proposal.k}
                    fallback={
                      <button type="button" data-slot="design-row" onClick={() => setExpanded(proposal.k)}>
                        <span data-slot="design-key">{proposal.k}</span>
                        <span data-slot="design-row-title">{proposal.title}</span>
                        <span data-slot="design-pill">{t("design.pill.open")}</span>
                      </button>
                    }
                  >
                    {card(proposal)}
                  </Show>
                )}
              </For>
            </div>
          </Show>

          <Show when={buckets().answered.length > 0}>
            <h4 data-slot="design-section">{t("design.section.answered")}</h4>
            <div data-slot="design-list">
              <For each={buckets().answered}>
                {(proposal) => (
                  <section data-slot="design-card" data-state="risposta">
                    <header data-slot="design-head">
                      <span data-slot="design-key">{proposal.k}</span>
                      <h3 data-slot="design-title">{proposal.title}</h3>
                      <span data-slot="design-pill" data-tone="done">{t("design.pill.answered")}</span>
                    </header>
                    <div data-slot="design-answer">
                      <b>{proposal.answer?.choice ?? proposal.answer?.words}</b>
                      <Show when={proposal.answer?.choice && proposal.answer?.note}> · {proposal.answer?.note}</Show>
                    </div>
                    <Show when={props.hub.problem(proposal.k)}>
                      <div data-slot="design-problem" role="alert">{props.hub.problem(proposal.k)}</div>
                    </Show>
                    <div data-slot="design-actions">
                      <span data-slot="design-hint">{deliveryText(props.hub, proposal, now())}</span>
                    </div>
                  </section>
                )}
              </For>
            </div>
          </Show>

          <Show when={buckets().closed.length > 0}>
            <button
              type="button"
              data-slot="design-section"
              data-toggle="true"
              aria-expanded={showClosed()}
              onClick={() => setShowClosed(!showClosed())}
            >
              {t("design.section.closed", buckets().closed.length)}
            </button>
            <Show when={showClosed()}>
              <div data-slot="design-list">
                <For each={[...buckets().closed].reverse()}>
                  {(proposal) => (
                    <div data-slot="design-row" data-static="true" title={proposal.answer?.words}>
                      <span data-slot="design-key">{proposal.k}</span>
                      <span data-slot="design-row-title">{proposal.title}</span>
                      <span data-slot="design-pill" data-tone="closed">
                        {t("design.pill.closed", formatDay(proposal.closedAt ?? proposal.openedAt, now()))}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </div>

      {/* Fullscreen Preview overlay */}
      <Show when={props.hub.fullPreview().open && props.hub.fullPreview().variant}>
        <div data-slot="design-full-preview-overlay" role="dialog" aria-modal="true">
          <header data-slot="full-preview-header">
            <div data-slot="full-preview-title-wrap">
              <span data-slot="full-preview-title">
                {props.hub.fullPreview().title} · <b>{props.hub.fullPreview().variant?.name}</b>
              </span>
              <span
                data-slot="full-preview-source"
                title={resolvePreviewPath(props.hub.fullPreview().variant!.preview, root())}
              >
                {shortenPath(resolvePreviewPath(props.hub.fullPreview().variant!.preview, root()))}
              </span>
            </div>
            <button
              type="button"
              data-slot="full-preview-close"
              onClick={() => props.hub.closeFullPreview()}
              aria-label={t("design.preview.close")}
            >
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6">
                <path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round" />
              </svg>
            </button>
          </header>
          <div data-slot="full-preview-container">
            <DesignPreview
              preview={props.hub.fullPreview().variant!.preview}
              name={props.hub.fullPreview().variant!.name}
              projectRoot={root()}
              fullScreen
              onToggleFullScreen={() => props.hub.closeFullPreview()}
            />
          </div>
        </div>
      </Show>
    </article>
  )
}

function DesignRecipientPicker(props: { hub: DesignHub; queued: number }) {
  const [pending, setPending] = createSignal<string>()
  const recipient = () => props.hub.recipient()
  const options = createMemo(() => recipientOptions(props.hub.sessions(), recipient(), pending()))

  const onChange = (nextId: string) => {
    const rec = recipient()
    const currentId = rec.state === "non scelta" ? undefined : rec.id
    const target = nextId || undefined
    const action = recipientChange(currentId, target, props.queued)
    if (action === "nessuna") return
    if (action === "applica") props.hub.choose(target)
    else setPending(target)
  }

  const applyPending = () => {
    props.hub.choose(pending())
    setPending(undefined)
  }

  return (
    <div data-slot="design-recipient-wrap">
      <div data-slot="design-recipient">
        <label for="design-recipient-select">{t("design.recipient")}</label>
        <select
          id="design-recipient-select"
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          <For each={options()}>
            {(option) => (
              <option value={option.value} selected={option.selected}>
                {option.label}
              </option>
            )}
          </For>
        </select>
      </div>

      <Show when={pending() !== undefined}>
        <div data-slot="design-confirm" role="alert">
          <span>
            {t(
              "design.recipient.confirm",
              props.queued,
              props.hub.sessions().find((p) => p.id === pending())?.title ?? pending() ?? "",
            )}
          </span>
          <button type="button" data-slot="design-submit" onClick={applyPending}>
            {t("design.recipient.deliver")}
          </button>
          <button type="button" data-slot="design-ghost" onClick={() => setPending(undefined)}>
            {t("new.cancel")}
          </button>
        </div>
      </Show>
    </div>
  )
}

function deliveryText(hub: DesignHub, proposal: DesignProposal, now: Date): string {
  const delivery = hub.delivery(proposal)
  if (delivery.state === "consegnata") {
    return t("design.delivery.done", delivery.to, formatMoment(delivery.at, now))
  }
  const recipient = hub.recipient()
  if (recipient.state === "pronta") return t("design.queued.ready", recipient.title)
  if (recipient.state === "non attiva") return t("design.queued.idle", recipient.title)
  return t("design.queued.none")
}

export function DesignGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">
      <path d="M11.5 2.5l2 2-7.5 7.5H4v-2l7.5-7.5z" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M10 4l2 2" stroke-linecap="round" />
    </svg>
  )
}
