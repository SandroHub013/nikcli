import { For, Show, createMemo, createSignal } from "solid-js"
import { formatDay, formatMoment } from "./answer"
import { DecisionCard } from "./decision-card"
import { recipientHint } from "./decisions-sheet"
import type { RecipientStatus } from "./delivery"
import type { DecisionsHub } from "./hub"
import { bucketDecisions, describeProblems, type Decision } from "./state"
import "./decisions.css"

/**
 * The whole register in a grid pane: who receives the answers, what waits for
 * the user, what waits to be carried out, what was put off and what is done.
 *
 * The window is the quick way through the open ones; this is where an answer
 * is changed, a deferral brought back early, and a closed decision looked up.
 */
export function DecisionsPane(props: {
  hub: DecisionsHub
  focused: boolean
  onFocus?: () => void
  onClose?: () => void
  onExpand?: () => void
}) {
  const state = () => props.hub.register.state()
  const buckets = createMemo(() => bucketDecisions(state()?.decisions ?? []))
  const [expanded, setExpanded] = createSignal<string>()
  const [showClosed, setShowClosed] = createSignal(false)
  const now = () => props.hub.register.now()
  // The first open decision is answerable in place; another one once clicked.
  const active = () => expanded() && buckets().forYou.some((d) => d.k === expanded()) ? expanded() : buckets().forYou[0]?.k
  const problems = createMemo(() => {
    const loaded = props.hub.register.loaded()
    return loaded ? describeProblems(loaded.problems, state()?.rejected ?? []) : []
  })

  const card = (decision: Decision) => (
    <DecisionCard
      decision={decision}
      picked={props.hub.draft(decision.k).picked}
      note={props.hub.draft(decision.k).note}
      busy={props.hub.busy(decision.k)}
      problem={props.hub.problem(decision.k)}
      submitLabel="Registra"
      recipientHint={recipientHint(props.hub.recipient())}
      now={now()}
      onPick={(picked) => props.hub.setDraft(decision.k, { ...props.hub.draft(decision.k), picked })}
      onNote={(text) => props.hub.setDraft(decision.k, { ...props.hub.draft(decision.k), note: text })}
      onSubmit={() => void props.hub.answer(decision)}
      onDefer={(until) => void props.hub.defer(decision, until)}
    />
  )

  return (
    <article
      data-component="decisions-pane"
      data-focused={props.focused ? "true" : undefined}
      onFocusIn={() => props.onFocus?.()}
      onPointerDown={() => props.onFocus?.()}
    >
      <header data-slot="pane-header">
        <span data-slot="pane-identity" aria-hidden="true">
          <DecisionsGlyph />
        </span>
        <h2 data-slot="pane-title" title={props.hub.register.path()}>
          Decisioni{buckets().forYou.length > 0 ? ` · ${buckets().forYou.length} ${buckets().forYou.length === 1 ? "aperta" : "aperte"}` : ""}
        </h2>
        <div data-slot="pane-actions">
          <button type="button" data-slot="pane-action" onClick={() => props.onExpand?.()} aria-label="Espandi">
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M1 4.5V1h3.5M11 7.5V11H7.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
          <button type="button" data-slot="pane-action" onClick={() => props.onClose?.()} aria-label="Chiudi">
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </header>

      <div data-slot="decisions-body">
        <Show when={!props.hub.register.path()}>
          <div data-slot="sheet-empty">
            <b>Nessun progetto aperto.</b>
            <span>Il registro delle decisioni sta in .ade/decisions.jsonl del progetto.</span>
          </div>
        </Show>
        <Show when={props.hub.register.error()}>
          <div data-slot="decision-problem" role="alert">Registro non leggibile: {props.hub.register.error()}</div>
        </Show>
        <Show when={problems().length > 0}>
          <details data-slot="decisions-problems">
            <summary>{problems().length === 1 ? "1 riga ignorata" : `${problems().length} righe ignorate`} nel registro</summary>
            <ul>
              <For each={problems()}>{(line) => <li>{line}</li>}</For>
            </ul>
          </details>
        </Show>

        <Show when={props.hub.register.path()}>
          <RecipientPicker hub={props.hub} queued={buckets().answered.filter((decision) => props.hub.delivery(decision).state === "in coda").length} />
          <h4 data-slot="decisions-section">Da decidere, in ordine</h4>
          <Show when={buckets().forYou.length > 0} fallback={<p data-slot="decisions-none">Nessuna decisione aperta.</p>}>
            <div data-slot="decisions-list">
              <For each={buckets().forYou}>
                {(decision) => (
                  <Show
                    when={active() === decision.k}
                    fallback={
                      <button type="button" data-slot="decision-row" onClick={() => setExpanded(decision.k)}>
                        <span data-slot="decision-key">{decision.k}</span>
                        <span data-slot="decision-row-title">{decision.title}</span>
                        <span data-slot="decision-pill">aperta</span>
                      </button>
                    }
                  >
                    {card(decision)}
                  </Show>
                )}
              </For>
            </div>
          </Show>

          <Show when={buckets().answered.length > 0}>
            <h4 data-slot="decisions-section">Risposte, in attesa di esecuzione</h4>
            <div data-slot="decisions-list">
              <For each={buckets().answered}>
                {(decision) => (
                  <section data-slot="decision-card" data-state="risposta">
                    <header data-slot="decision-head">
                      <span data-slot="decision-key">{decision.k}</span>
                      <h3 data-slot="decision-title">{decision.title}</h3>
                      <span data-slot="decision-pill" data-tone="done">risposta</span>
                    </header>
                    <div data-slot="decision-answer">
                      <b>{decision.answer?.choice ?? decision.answer?.words}</b>
                      <Show when={decision.answer?.choice && decision.answer?.note}> · {decision.answer?.note}</Show>
                    </div>
                    <Show when={props.hub.problem(decision.k)}>
                      <div data-slot="decision-problem" role="alert">{props.hub.problem(decision.k)}</div>
                    </Show>
                    <div data-slot="decision-actions">
                      <span data-slot="decision-hint">{deliveryText(props.hub, decision, now())}</span>
                      <button
                        type="button"
                        data-slot="decision-ghost"
                        disabled={props.hub.busy(decision.k)}
                        onClick={() => void props.hub.reopen(decision).then((done) => done && setExpanded(decision.k))}
                      >
                        Cambia risposta
                      </button>
                    </div>
                  </section>
                )}
              </For>
            </div>
          </Show>

          <Show when={buckets().later.length > 0}>
            <h4 data-slot="decisions-section">Prossimo</h4>
            <div data-slot="decisions-list">
              <For each={buckets().later}>
                {(decision) => (
                  <div data-slot="decision-row" data-static="true">
                    <span data-slot="decision-key">{decision.k}</span>
                    <span data-slot="decision-row-title">{decision.title}</span>
                    <span data-slot="decision-pill" data-tone="later">
                      rimandata · {formatDay(decision.deferredUntil ?? "", now())}
                    </span>
                    <button
                      type="button"
                      data-slot="decision-ghost"
                      disabled={props.hub.busy(decision.k)}
                      onClick={() => void props.hub.reopen(decision).then((done) => done && setExpanded(decision.k))}
                    >
                      Riapri ora
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <Show when={buckets().closed.length > 0}>
            <button
              type="button"
              data-slot="decisions-section"
              data-toggle="true"
              aria-expanded={showClosed()}
              onClick={() => setShowClosed(!showClosed())}
            >
              Chiuse · {buckets().closed.length}
            </button>
            <Show when={showClosed()}>
              <div data-slot="decisions-list">
                <For each={[...buckets().closed].reverse()}>
                  {(decision) => (
                    <div data-slot="decision-row" data-static="true" title={decision.answer?.words}>
                      <span data-slot="decision-key">{decision.k}</span>
                      <span data-slot="decision-row-title">
                        {decision.title}
                        <Show when={decision.answer}> — {decision.answer?.choice ?? decision.answer?.words}</Show>
                      </span>
                      <span data-slot="decision-pill" data-tone="closed">
                        {decision.evidence ?? `chiusa ${formatDay(decision.closedAt ?? "", now())}`}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </article>
  )
}

function deliveryText(hub: DecisionsHub, decision: Decision, now: Date): string {
  const delivery = hub.delivery(decision)
  if (delivery.state === "consegnata") return `✓ consegnata a ${delivery.to} · ${formatMoment(delivery.at, now)} · chi la esegue la chiude`
  if (delivery.state === "in coda") return queuedText(hub.recipient())
  return `risposta di ${decision.answer?.by ?? "?"} · ${formatDay(decision.answer?.at ?? "", now)}`
}

export function queuedText(recipient: RecipientStatus): string {
  if (recipient.state === "pronta") return `in coda: parte appena «${recipient.title}» è libera`
  if (recipient.state === "non attiva") return `in coda: parte quando «${recipient.title}» è in esecuzione`
  return "in coda: nessuna sessione scelta per le risposte"
}

/**
 * "Risposte a": any session, from any project, or nobody. With nobody, or with
 * a session that is not running, answers stay queued and the warning says so.
 */
function RecipientPicker(props: { hub: DecisionsHub; queued: number }) {
  const status = () => props.hub.recipient()
  const chosenId = () => (status().state === "non scelta" ? "" : (status() as { id: string }).id)
  // A chosen session whose pane was closed is still listed, so the choice stays visible.
  const missing = () => {
    const current = status()
    return current.state !== "non scelta" && !props.hub.sessions().some((pane) => pane.id === current.id) ? current : undefined
  }
  return (
    <div data-slot="decisions-recipient" data-state={status().state}>
      <label>
        <span>Risposte a</span>
        <select value={chosenId()} onChange={(event) => props.hub.choose(event.currentTarget.value || undefined)}>
          <option value="">nessuna sessione</option>
          <For each={props.hub.sessions()}>
            {(pane) => (
              <option value={pane.id}>
                {pane.title}
                {pane.project ? ` · ${pane.project}` : ""}
                {pane.running ? "" : " (ferma)"}
              </option>
            )}
          </For>
          <Show when={missing()}>{(gone) => <option value={gone().id}>{gone().title} (chiusa)</option>}</Show>
        </select>
      </label>
      <Show when={status().state !== "pronta"}>
        <p data-slot="decisions-recipient-warning" role="status">
          {status().state === "non scelta"
            ? "Nessuna sessione riceve le risposte: restano in coda finché non ne scegli una."
            : `«${(status() as { title: string }).title}» non è in esecuzione: le risposte restano in coda.`}
          {props.queued > 0 ? ` ${props.queued === 1 ? "1 in attesa" : `${props.queued} in attesa`}.` : ""}
        </p>
      </Show>
    </div>
  )
}

export function DecisionsGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
      <path d="M8 1.8v3.4M8 5.2L3.2 9.4M8 5.2l4.8 4.2" stroke-linecap="round" stroke-linejoin="round" />
      <circle cx="3.2" cy="11.6" r="2.2" />
      <circle cx="12.8" cy="11.6" r="2.2" />
    </svg>
  )
}
