import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { Overlay, Surface } from "../ui/layout"
import { sheetKey } from "./answer"
import { DecisionCard } from "./decision-card"
import type { RecipientStatus } from "./delivery"
import type { DecisionsHub } from "./hub"
import { bucketDecisions } from "./state"
import "./decisions.css"

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

  onMount(() => surface?.focus())

  const submit = async () => {
    const decision = current()
    if (!decision) return
    if (await props.hub.answer(decision)) surface?.focus()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const decision = current()
    const action = sheetKey(event, decision?.options.length ?? 0, event.target === note)
    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    if (action.kind === "close") props.onClose()
    else if (!decision) return
    else if (action.kind === "pick") props.hub.setDraft(decision.k, { ...props.hub.draft(decision.k), picked: action.index })
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
        aria-label="Decisioni per te"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header data-slot="sheet-head">
          <strong>Decisioni per te</strong>
          <Show when={open().length > 0}>
            <span data-slot="sheet-count">{at() + 1} di {open().length}</span>
            <span data-slot="sheet-steps" aria-hidden="true">
              <For each={open()}>{(_, i) => <i data-on={i() === at() ? "true" : undefined} />}</For>
            </span>
          </Show>
          <button type="button" data-slot="sheet-close" onClick={() => props.onClose()} aria-label="Chiudi">
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
        </header>

        <div data-slot="sheet-body">
          <Show when={props.hub.register.error()}>
            <div data-slot="decision-problem" role="alert">Registro non leggibile: {props.hub.register.error()}</div>
          </Show>
          <Show
            when={current()}
            keyed
            fallback={
              <div data-slot="sheet-empty">
                <b>Nessuna decisione aperta.</b>
                <span>Quando una sessione ne apre una, il badge in alto la mostra.</span>
              </div>
            }
          >
            {(decision) => (
              <DecisionCard
                decision={decision}
                picked={props.hub.draft(decision.k).picked}
                note={props.hub.draft(decision.k).note}
                busy={props.hub.busy(decision.k)}
                problem={props.hub.problem(decision.k)}
                submitLabel={open().length > 1 ? "Registra e avanti" : "Registra"}
                recipientHint={recipientHint(props.hub.recipient())}
                now={props.hub.register.now()}
                onPick={(picked) => props.hub.setDraft(decision.k, { ...props.hub.draft(decision.k), picked })}
                onNote={(text) => props.hub.setDraft(decision.k, { ...props.hub.draft(decision.k), note: text })}
                onSubmit={() => void submit()}
                onDefer={(until) => void props.hub.defer(decision, until).then((done) => done && surface?.focus())}
                noteRef={(element) => (note = element)}
              />
            )}
          </Show>
        </div>

        <footer data-slot="sheet-foot">
          <span>1–9 sceglie · Invio registra · ← → scorre · Esc chiude</span>
          <Show when={props.hub.recipient().state !== "pronta" && queued() > 0}>
            <span data-tone="warn">
              {queued() === 1 ? "1 risposta" : `${queued()} risposte`} in coda:{" "}
              {props.hub.recipient().state === "non scelta" ? "nessuna sessione le riceve" : "la sessione scelta non è in esecuzione"}
            </span>
          </Show>
          <button type="button" data-slot="decision-ghost" onClick={() => props.onOpenPanel()}>
            Vista completa
          </button>
        </footer>
      </Surface>
    </Overlay>
  )
}

export function recipientHint(recipient: RecipientStatus): string {
  if (recipient.state === "pronta") return `→ ${recipient.title}, come messaggio`
  if (recipient.state === "non attiva") return `→ in coda: «${recipient.title}» non è in esecuzione`
  return "→ in coda: scegli chi riceve le risposte nella vista completa"
}
