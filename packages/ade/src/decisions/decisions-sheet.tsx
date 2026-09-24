import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { Overlay, Surface } from "../ui/layout"
import { enterReady, isFormField, sheetKey, togglePick } from "./answer"
import { submitControl } from "./card"
import { DecisionCard } from "./decision-card"
import type { RecipientStatus } from "./delivery"
import type { DecisionsHub } from "./hub"
import { bucketDecisions } from "./state"
import "./decisions.css"
import { t } from "../i18n"

/**
 * The open decisions, one at a time, in the order they matter.
 *
 * Opened from the badge in the bar, never by itself. Answering one moves to
 * the next; Esc closes and leaves the rest open. The digits pick, Enter
 * records, the arrows move without answering.
 */
export function DecisionsSheet(props: { hub: DecisionsHub; onClose: () => void; onOpenPanel: () => void }) {
  const buckets = createMemo(() => bucketDecisions(props.hub.register.state()?.decisions ?? []))
  const open = () => buckets().forYou
  const queued = () => buckets().answered.filter((decision) => props.hub.delivery(decision).state === "in coda").length
  const [index, setIndex] = createSignal(0)
  // An answered decision leaves the list and the next one takes its place.
  const at = () => Math.min(index(), Math.max(0, open().length - 1))
  const current = () => open()[at()]
  let surface: HTMLDivElement | undefined
  let note: HTMLTextAreaElement | undefined

  /*
   * Nothing chosen when the window opens, whatever a draft in the panel held:
   * the choice has to be made here, so Enter never records one by accident.
   * The note is kept.
   */
  const [chosenHere, setChosenHere] = createSignal<ReadonlySet<string>>(new Set())
  const [needChoice, setNeedChoice] = createSignal<string>()
  const pick = (k: string, index: number, multi: boolean) => {
    const draft = props.hub.draft(k)
    props.hub.setDraft(k, { ...draft, picked: togglePick(draft.picked, index, multi) })
    setChosenHere((keys) => new Set(keys).add(k))
    setNeedChoice(undefined)
  }

  onMount(() => {
    for (const decision of open()) {
      const draft = props.hub.draft(decision.k)
      if (draft.picked !== undefined) props.hub.setDraft(decision.k, { ...draft, picked: undefined })
    }
    surface?.focus()
  })

  const submit = async (press: "primary" | "record" = "primary") => {
    const decision = current()
    if (!decision) return
    if (await props.hub.submit(decision, press)) surface?.focus()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const decision = current()
    const draft = decision ? props.hub.draft(decision.k) : undefined
    const picked = Boolean(decision && draft && enterReady(Boolean(decision.multi), draft.picked, draft.note, chosenHere().has(decision.k)))
    const inText = event.target === note
    const action = sheetKey(event, decision?.options.length ?? 0, inText, picked, !inText && isFormField(event.target))
    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    if (action.kind === "close") props.onClose()
    else if (!decision) return
    else if (action.kind === "pick") pick(decision.k, action.index, Boolean(decision.multi))
    else if (action.kind === "need-choice") setNeedChoice(decision.k)
    else if (action.kind === "submit") void submit()
    else if (action.kind === "next") setIndex(Math.min(at() + 1, open().length - 1))
    else if (action.kind === "previous") setIndex(Math.max(at() - 1, 0))
  }

  return (
    <Overlay data-component="decisions-sheet" onClose={props.onClose}>
      <Surface
        ref={surface}
        size="md"
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.decisions.open")}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header data-slot="sheet-head">
          <strong>{t("palette.decisions.open")}</strong>
          <Show when={open().length > 0}>
            <span data-slot="sheet-count">{t("decisions.sheet.position", at() + 1, open().length)}</span>
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
            <div data-slot="decision-problem" role="alert">{t("decisions.unreadable", String(props.hub.register.error()))}</div>
          </Show>
          <Show
            when={current()?.k}
            keyed
            fallback={
              <div data-slot="sheet-empty">
                <b>{t("decisions.none")}</b>
                <span>{t("decisions.sheet.empty")}</span>
              </div>
            }
          >
            {(k) => {
              const decision = () => current()!
              return (
                <DecisionCard
                  decision={decision()}
                  picked={props.hub.draft(k).picked}
                  note={props.hub.draft(k).note}
                  busy={props.hub.busy(k)}
                  problem={
                    props.hub.problem(k) ??
                    (needChoice() === k
                      ? decision().options.length > 0
                        ? t("decisions.sheet.needChoice")
                        : t("decisions.sheet.needText")
                      : undefined)
                  }
                  control={submitControl({
                    recipient: props.hub.recipient(),
                    sessions: props.hub.sessions(),
                    inline: props.hub.inlineRecipient(),
                    busy: props.hub.busy(k),
                    label: open().length > 1 ? t("decisions.submitNext") : t("decisions.submit"),
                  })}
                  onInline={(id) => props.hub.setInlineRecipient(id)}
                  onRecord={() => void submit("record")}
                  recipientHint={recipientHint(props.hub.recipient())}
                  now={props.hub.register.now()}
                  onPick={(index) => pick(k, index, Boolean(decision().multi))}
                  onNote={(text) => props.hub.setDraft(k, { ...props.hub.draft(k), note: text })}
                  onSubmit={() => void submit()}
                  onDefer={(until) => void props.hub.defer(decision(), until).then((done) => done && surface?.focus())}
                  noteRef={(element) => (note = element)}
                />
              )
            }}
          </Show>
        </div>

        <footer data-slot="sheet-foot">
          <span>{t("decisions.sheet.keys")}</span>
          <Show when={props.hub.recipient().state !== "pronta" && queued() > 0}>
            <span data-tone="warn">
              {t(props.hub.recipient().state === "non scelta" ? "decisions.sheet.queued.none" : "decisions.sheet.queued.idle", queued())}
            </span>
          </Show>
          <button type="button" data-slot="decision-ghost" onClick={() => props.onOpenPanel()}>
            {t("decisions.sheet.full")}
          </button>
        </footer>
      </Surface>
    </Overlay>
  )
}

export function recipientHint(recipient: RecipientStatus): string {
  if (recipient.state === "pronta") return t("decisions.hint.ready", recipient.title)
  if (recipient.state === "non attiva") return t("decisions.hint.idle", recipient.title)
  return t("decisions.hint.none")
}
