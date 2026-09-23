import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { Overlay, Surface } from "../ui/layout"
import { enterReady, firstPick, sheetKey, togglePick } from "./answer"
import { isFormField } from "../decisions/answer"
import { submitControl } from "./card"
import { DesignCard } from "./design-card"
import { DesignPreview, resolvePreviewPath, shortenPath } from "./design-preview"
import type { RecipientStatus } from "./delivery"
import { projectRootFromRegisterPath, type DesignHub } from "./hub"
import { bucketProposals } from "./state"
import "./design.css"
import { t } from "../i18n"

export function DesignSheet(props: { hub: DesignHub; onClose: () => void; onOpenPanel: () => void }) {
  const root = () => props.hub.projectRoot?.() ?? projectRootFromRegisterPath(props.hub.register.path())
  const buckets = createMemo(() => bucketProposals(props.hub.register.state()?.proposals ?? []))
  const open = () => buckets().forYou
  const queued = () =>
    [...buckets().answered, ...buckets().rework].filter((proposal) => props.hub.delivery(proposal).state === "in coda").length
  const [index, setIndex] = createSignal(0)
  const at = () => Math.min(index(), Math.max(0, open().length - 1))
  const current = () => open()[at()]
  let surface: HTMLDivElement | undefined
  let note: HTMLTextAreaElement | undefined

  const [chosenHere, setChosenHere] = createSignal<ReadonlySet<string>>(new Set())
  const [needChoice, setNeedChoice] = createSignal<string>()

  const pick = (k: string, index: number, multi: boolean) => {
    const draft = props.hub.draft(k)
    props.hub.setDraft(k, { ...draft, picked: togglePick(draft.picked, index, multi) })
    setChosenHere((keys) => new Set(keys).add(k))
    setNeedChoice(undefined)
  }

  onMount(() => {
    for (const proposal of open()) {
      const draft = props.hub.draft(proposal.k)
      if (draft.picked !== undefined) props.hub.setDraft(proposal.k, { ...draft, picked: undefined })
    }
    surface?.focus()
  })

  const submit = async (press: "primary" | "record" = "primary") => {
    const proposal = current()
    if (!proposal) return
    if (await props.hub.submit(proposal, press)) surface?.focus()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (props.hub.fullPreview().open) {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        props.hub.closeFullPreview()
        surface?.focus()
        return
      }
    }

    const proposal = current()
    const draft = proposal ? props.hub.draft(proposal.k) : undefined
    const picked = Boolean(proposal && draft && enterReady(Boolean(proposal.multi), draft.picked, draft.note, chosenHere().has(proposal.k)))
    const inText = event.target === note
    const action = sheetKey(event, proposal?.variants.length ?? 0, inText, picked, !inText && isFormField(event.target))
    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    if (action.kind === "close") props.onClose()
    else if (!proposal) return
    else if (action.kind === "pick") pick(proposal.k, action.index, Boolean(proposal.multi))
    else if (action.kind === "need-choice") setNeedChoice(proposal.k)
    else if (action.kind === "submit") void submit()
    else if (action.kind === "next") setIndex(Math.min(at() + 1, open().length - 1))
    else if (action.kind === "previous") setIndex(Math.max(at() - 1, 0))
    else if (action.kind === "expand") {
      const pickedIndex = firstPick(props.hub.draft(proposal.k).picked) ?? 0
      const variant = proposal.variants[pickedIndex]
      if (variant) props.hub.openFullPreview(variant, proposal.title, proposal.k)
    }
  }

  return (
    <Overlay data-component="design-sheet" onClose={props.onClose}>
      <Surface
        ref={surface}
        size="lg"
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.design.open")}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header data-slot="sheet-head">
          <strong>{t("palette.design.open")}</strong>
          <Show when={open().length > 0}>
            <span data-slot="sheet-count">{t("design.sheet.position", at() + 1, open().length)}</span>
            <span data-slot="sheet-steps" aria-hidden="true">
              <For each={open()}>{(_, i) => <i data-on={i() === at() ? "true" : undefined} />}</For>
            </span>
          </Show>
          <button type="button" data-slot="sheet-close" onClick={() => props.onClose()} aria-label={t("new.close")}>
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
        </header>

        <div data-slot="sheet-body">
          <Show when={props.hub.register.error()}>
            <div data-slot="design-problem" role="alert">{t("design.unreadable", String(props.hub.register.error()))}</div>
          </Show>
          <Show
            when={current()}
            keyed
            fallback={
              <div data-slot="sheet-empty">
                <b>{t("design.none")}</b>
                <span>{t("design.sheet.empty")}</span>
              </div>
            }
          >
            {(proposal) => (
              <DesignCard
                proposal={proposal}
                picked={props.hub.draft(proposal.k).picked}
                note={props.hub.draft(proposal.k).note}
                busy={props.hub.busy(proposal.k)}
                problem={
                  props.hub.problem(proposal.k) ??
                  (needChoice() === proposal.k ? t("design.sheet.needChoice") : undefined)
                }
                control={submitControl({
                  recipient: props.hub.recipient(),
                  sessions: props.hub.sessions(),
                  inline: props.hub.inlineRecipient(),
                  busy: props.hub.busy(proposal.k),
                  label: open().length > 1 ? t("design.submitNext") : t("design.submit"),
                })}
                onInline={(id) => props.hub.setInlineRecipient(id)}
                onRecord={() => void submit("record")}
                onAgain={() => void props.hub.again(proposal).then((done) => done && surface?.focus())}
                recipientHint={recipientHint(props.hub.recipient())}
                now={new Date()}
                projectRoot={root()}
                onPick={(index) => pick(proposal.k, index, Boolean(proposal.multi))}
                onNote={(text) => props.hub.setDraft(proposal.k, { ...props.hub.draft(proposal.k), note: text })}
                onSubmit={() => void submit()}
                onOpenFullPreview={(variant) => props.hub.openFullPreview(variant, proposal.title, proposal.k)}
                noteRef={(element) => (note = element)}
              />
            )}
          </Show>
        </div>

        <footer data-slot="sheet-foot">
          <span>{t("design.sheet.keys")}</span>
          <Show when={props.hub.recipient().state !== "pronta" && queued() > 0}>
            <span data-tone="warn">
              {t(props.hub.recipient().state === "non scelta" ? "design.sheet.queued.none" : "design.sheet.queued.idle", queued())}
            </span>
          </Show>
          <button type="button" data-slot="design-ghost" onClick={() => props.onOpenPanel()}>
            {t("design.sheet.full")}
          </button>
        </footer>

        {/* Fullscreen Preview Ingranditore Overlay */}
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
                k={props.hub.fullPreview().k ?? ""}
                name={props.hub.fullPreview().variant!.name}
                projectRoot={root()}
                fullScreen
                onToggleFullScreen={() => props.hub.closeFullPreview()}
              />
            </div>
          </div>
        </Show>
      </Surface>
    </Overlay>
  )
}

export function recipientHint(recipient: RecipientStatus): string {
  if (recipient.state === "pronta") return t("design.hint.ready", recipient.title)
  if (recipient.state === "non attiva") return t("design.hint.idle", recipient.title)
  return t("design.hint.none")
}
