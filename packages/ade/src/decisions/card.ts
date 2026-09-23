/**
 * What the answer buttons of a decision card show and do.
 *
 * The card only draws this: which buttons, with which words, enabled or not,
 * and the steps a press runs. Solid components are not rendered in `bun test`
 * here, so the behaviour lives in plain functions next to the card and the
 * card's tests are written against them, like `sheetKey`.
 */

import { recipientOptions, submitGate, type DeliveryCandidate, type RecipientOption, type RecipientStatus } from "./delivery"
import { t } from "../i18n"

export interface SubmitControl {
  readonly gate: "invia" | "scegli"
  /** The main button's words. */
  readonly label: string
  readonly disabled: boolean
  /** The inline "who receives" select, only when the gate is `scegli`. */
  readonly options?: readonly RecipientOption[]
  /** «Registra senza inviare» is offered next to the main button. */
  readonly recordOnly: boolean
}

/**
 * The answer buttons for the current recipient. `inline` is the session picked
 * in the card's own select, not yet chosen for the project.
 */
export function submitControl(input: {
  recipient: RecipientStatus
  sessions: readonly DeliveryCandidate[]
  inline: string | undefined
  busy: boolean
  label: string
}): SubmitControl {
  const gate = submitGate(input.recipient)
  if (gate === "invia") return { gate, label: input.label, disabled: input.busy, recordOnly: false }
  return {
    gate,
    label: t("decisions.submit.choose"),
    disabled: input.busy || !runningPick(input.sessions, input.inline),
    options: recipientOptions(input.sessions, input.recipient, input.inline ?? ""),
    recordOnly: true,
  }
}

/** The session picked inline, if it is one that can receive now. */
function runningPick(sessions: readonly DeliveryCandidate[], inline: string | undefined): string | undefined {
  return inline && sessions.some((pane) => pane.id === inline && pane.running) ? inline : undefined
}

export type SubmitStep = { readonly kind: "choose"; readonly id: string } | { readonly kind: "answer" }

/**
 * What a press runs, in order. `primary` is the main button, and Enter or
 * Ctrl+Enter, which do what it does; `record` is «Registra senza inviare».
 * A disabled main button runs nothing.
 */
export function submitSteps(
  control: SubmitControl,
  sessions: readonly DeliveryCandidate[],
  inline: string | undefined,
  press: "primary" | "record",
): SubmitStep[] {
  if (press === "record") return control.recordOnly ? [{ kind: "answer" }] : []
  if (control.disabled) return []
  if (control.gate === "invia") return [{ kind: "answer" }]
  const id = runningPick(sessions, inline)
  return id ? [{ kind: "choose", id }, { kind: "answer" }] : []
}

/** Runs the steps; true once an answer is in the register. */
export async function runSubmit(
  steps: readonly SubmitStep[],
  deps: { choose: (id: string) => void; answer: () => Promise<boolean> },
): Promise<boolean> {
  let answered = false
  for (const step of steps) {
    if (step.kind === "choose") deps.choose(step.id)
    else answered = await deps.answer()
  }
  return answered
}

/**
 * «· N scartate» on the bar button: lines the parser threw away and events
 * the fold refused. A line written by hand that is wrong must not pass
 * unseen, so the button shows even when nothing else would.
 */
export function discardedBadge(discarded: number): string | undefined {
  return discarded > 0 ? t("decisions.badge.discarded", discarded) : undefined
}

/** «· N in coda» on the bar button, or nothing. */
export function queuedBadge(queued: number): string | undefined {
  return queued > 0 ? t("decisions.badge.queued", queued) : undefined
}
