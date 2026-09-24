/**
 * Dialogue state machine for voice interaction in ADE.
 *
 * Implements a pure finite state machine: (state, event, now, ctx) -> { state, effects }.
 * Zero direct I/O, zero global variables, zero internal Date.now() calls.
 * All time is explicitly injected via the `now` parameter.
 *
 * Core behavioural guarantees:
 * 1. Destructive intents (process.kill, pane.close, permission rejection) NEVER execute directly.
 *    They enter 'confirming' and require explicit dialog.confirm ("si", "conferma").
 * 2. In 'dictating' mode, utterances are NOT parsed as commands; they accumulate into
 *    the prompt buffer until a closing phrase ("fine dettatura", "invia") completes the task.
 * 3. Pending permissions from agent CLIs take precedence, immediately entering 'confirming'.
 * 4. Wake/sleep toggling isolates workbench actions from casual room speech.
 */

import type { ParseContext } from "../intent/parse"
import { hasNegation, parseUtterance } from "../intent/parse"
import { normalizeUtterance } from "../intent/normalize"
import { VOCABULARY, type VoiceIntentSpec } from "../intent/vocabulary"
import type { PlanStep } from "../plan/schema"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DialogStatus =
  | "asleep"
  | "idle"
  | "listening"
  | "confirming"
  | "dictating"
  | "executing"

export interface PendingAction {
  /** The parsed intent awaiting explicit confirmation. */
  intent: VoiceIntentSpec
  /** Extracted slots for execution. */
  slots: Record<string, any>
  /** Prompt phrase to speak when requesting confirmation. */
  confirmPrompt: string
  /** True when confirming an interactive agent CLI permission. */
  isPermission?: boolean
  /** Target pane ID for permissions. */
  paneId?: string
}

export interface DictationBuffer {
  /** Target pane ID to receive the finalized prompt. */
  paneId?: string
  /** Accumulated chunks of freeform spoken text. */
  chunks: string[]
}

export interface DialogState {
  /** Current state of the dialogue system. */
  status: DialogStatus
  /** Action held in escrow pending confirmation. */
  pendingAction?: PendingAction
  /** Ongoing prompt dictation buffer. */
  dictation?: DictationBuffer
  /**
   * A permission that arrived while the dialogue was already busy: a
   * confirmation in flight, a dictation, or sleep. Held here until the busy
   * state ends, then promoted to `confirming`. Never overwrites
   * `pendingAction` — that was the bug: a second permission replaced the
   * first question, and the user's «sì» answered the wrong one.
   */
  queuedPermission?: { paneId: string; what: string; silent?: boolean }
  /**
   * A validated plan whose steps include `send_prompt`, held in confirming
   * until the user says yes. Without this the planner pressed Enter the
   * moment the model returned a plan — the one action a person never gets
   * to see before it happens. Plans without `send_prompt` still run
   * immediately; only the submit step waits.
   */
  pendingPlan?: { steps: PlanStep[]; refusals: string[]; speech?: string }
  /** Timestamp (epoch ms) when the current confirmation timer expires. */
  timeoutAt?: number
  /** Last spoken Italian phrase emitted by the system, for dialog.repeat. */
  lastSpokenText?: string
}

export type DialogEffect =
  | { type: "speak"; text: string }
  | { type: "start_timer"; durationMs: number; timeoutAt: number }
  | { type: "cancel_timer" }
  | { type: "execute_intent"; intent: VoiceIntentSpec; slots: Record<string, any> }
  | { type: "answer_permission"; paneId: string; answer: "allow" | "deny" }
  | { type: "send_prompt"; paneId?: string; text: string }
  | { type: "execute_plan"; steps: PlanStep[]; refusals: string[]; speech?: string }

export type DialogEvent =
  | { type: "wake" }
  | { type: "sleep" }
  | { type: "utterance"; text: string }
  | { type: "permission_requested"; paneId: string; what: string; silent?: boolean }
  | { type: "permission_resolved"; paneId: string }
  | { type: "command_success"; readback?: string }
  | { type: "command_failed"; error: string }
  | { type: "timeout" }
  | { type: "cancel" }

export interface TransitionResult {
  state: DialogState
  effects: DialogEffect[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIRMATION_TIMEOUT_MS = 15_000
export const DEFAULT_PERMISSION_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function createInitialDialogState(status: DialogStatus = "idle"): DialogState {
  return {
    status,
  }
}

function isDictationFinishPhrase(text: string): boolean {
  const norm = normalizeUtterance(text)
  return (
    norm === "fine dettatura" ||
    norm === "termina dettatura" ||
    norm === "invia dettatura" ||
    norm === "concludi dettatura" ||
    norm === "invia"
  )
}

/**
 * The spoken form of a permission question: which panel, which tool. Built in
 * one place so the live request and a promoted queue entry ask identically.
 */
function permissionPrompt(
  paneId: string,
  what: string,
  ctx: ParseContext,
): string {
  const paneTitle = ctx.panes?.find((p) => p.id === paneId)?.title ?? paneId
  return `L'agente sul pannello «${paneTitle}» richiede il permesso per: ${what}. Vuoi consentire?`
}

/**
 * Promotes a queued permission into `confirming`, replacing whatever idle /
 * dictation-finished state the caller was about to return. Returns null when
 * nothing is queued, so every exit path can say `promote(...) ?? fallback`.
 *
 * The timer is restarted for the permission's own window; `cancel_timer`
 * first so a leftover confirmation timer cannot fire against the new prompt.
 */
function promoteQueuedPermission(
  state: DialogState,
  now: number,
  ctx: ParseContext,
  effects: DialogEffect[],
): TransitionResult | null {
  const req = state.queuedPermission
  if (!req) return null

  effects.push({ type: "cancel_timer" })
  const timeoutAt = now + DEFAULT_PERMISSION_TIMEOUT_MS
  effects.push({
    type: "start_timer",
    durationMs: DEFAULT_PERMISSION_TIMEOUT_MS,
    timeoutAt,
  })

  const permAllowSpec = VOCABULARY.find((v) => v.intent === "permission.allow")!
  const prompt = permissionPrompt(req.paneId, req.what, ctx)

  const nextState: DialogState = {
    ...state,
    status: "confirming",
    timeoutAt,
    queuedPermission: undefined,
    pendingAction: {
      intent: permAllowSpec,
      slots: { paneId: req.paneId },
      confirmPrompt: prompt,
      isPermission: true,
      paneId: req.paneId,
    },
  }

  /* Silent meant "do not interrupt on arrival"; once the question is on
   * screen it must be read aloud, or it waits for a phrase nobody heard. */
  return withSpokenLocal(nextState, prompt, effects)
}

/** Same as the machine's `withSpoken`, usable from the module-level helper. */
function withSpokenLocal(
  nextState: DialogState,
  text: string,
  effects: DialogEffect[],
): TransitionResult {
  effects.push({ type: "speak", text })
  return {
    state: { ...nextState, lastSpokenText: text },
    effects,
  }
}

// ---------------------------------------------------------------------------
// State Machine Transition Function
// ---------------------------------------------------------------------------

/**
 * Pure state machine transition function.
 *
 * @param state Previous dialogue state
 * @param event Input event received
 * @param now Injected current timestamp (epoch ms)
 * @param ctx Contextual ADE workbench state for intent resolution
 */
export function transition(
  state: DialogState,
  event: DialogEvent,
  now: number,
  ctx: ParseContext = {}
): TransitionResult {
  const effects: DialogEffect[] = []

  const withSpoken = (nextState: DialogState, text: string): TransitionResult => {
    effects.push({ type: "speak", text })
    return {
      state: {
        ...nextState,
        lastSpokenText: text,
      },
      effects,
    }
  }

  // 1. Agent permission request: preempts idle and executing, queues behind
  //    an in-flight confirmation, a dictation, or sleep.
  if (event.type === "permission_requested") {
    /*
     * Rilievo 3: arriving during confirming, dictating or asleep used to
     * overwrite `pendingAction` (or yank a sleeping dialog into confirming).
     * The user's «sì» then answered the wrong question, and from sleep any
     * room noise could grant for 30 s. Queue instead: the busy state keeps
     * the floor; the permission is announced and promoted when it ends.
     */
    if (
      state.status === "confirming" ||
      state.status === "dictating" ||
      state.status === "asleep"
    ) {
      /* First in wins: a second arrival while one is already waiting does
       * not drop the first question on the floor. */
      const queuedPermission = state.queuedPermission ?? {
        paneId: event.paneId,
        what: event.what,
        silent: event.silent,
      }
      const nextState = { ...state, queuedPermission }

      if (event.silent) {
        return { state: nextState, effects: [] }
      }

      const paneTitle =
        ctx.panes?.find((p) => p.id === event.paneId)?.title ?? event.paneId
      return withSpokenLocal(
        nextState,
        `Ho messo in coda una richiesta di permesso dal pannello «${paneTitle}» per: ${event.what}. La affronto appena posso.`,
        effects,
      )
    }

    effects.push({ type: "cancel_timer" })
    const timeoutAt = now + DEFAULT_PERMISSION_TIMEOUT_MS
    effects.push({
      type: "start_timer",
      durationMs: DEFAULT_PERMISSION_TIMEOUT_MS,
      timeoutAt,
    })

    const permAllowSpec = VOCABULARY.find((v) => v.intent === "permission.allow")!
    const prompt = permissionPrompt(event.paneId, event.what, ctx)

    const nextState: DialogState = {
      ...state,
      status: "confirming",
      timeoutAt,
      pendingAction: {
        intent: permAllowSpec,
        slots: { paneId: event.paneId },
        confirmPrompt: prompt,
        isPermission: true,
        paneId: event.paneId,
      },
    }

    if (event.silent) {
      return {
        state: nextState,
        effects,
      }
    }

    return withSpoken(nextState, prompt)
  }

  // 2. State: ASLEEP
  if (state.status === "asleep") {
    if (event.type === "wake") {
      const woken = { ...state, status: "idle" as const }
      return (
        promoteQueuedPermission(woken, now, ctx, effects) ??
        withSpoken(woken, "Sono sveglio e in ascolto.")
      )
    }

    if (event.type === "utterance") {
      const parsed = parseUtterance(event.text, ctx)
      if (parsed.outcome === "matched" && parsed.intent?.intent === "voice.wake") {
        return withSpoken({ ...state, status: "idle" }, "Sono sveglio e in ascolto.")
      }
    }

    // Ignore all other inputs while asleep
    return { state, effects: [] }
  }

  // 3. State: DICTATING
  if (state.status === "dictating") {
    if (event.type === "cancel") {
      const abandoned: DialogState = { ...state, status: "idle", dictation: undefined }
      return (
        promoteQueuedPermission(abandoned, now, ctx, effects) ??
        withSpoken(abandoned, "Dettatura annullata.")
      )
    }

    if (event.type === "utterance") {
      if (isDictationFinishPhrase(event.text)) {
        const fullPrompt = (state.dictation?.chunks ?? []).join(" ").trim()
        const targetPane = state.dictation?.paneId
        const finished: DialogState = { ...state, status: "idle", dictation: undefined }

        if (fullPrompt.length > 0) {
          effects.push({
            type: "send_prompt",
            paneId: targetPane,
            text: fullPrompt,
          })
          /* A permission that arrived mid-dictation is asked now that the
           * text has gone out; it must not vanish with the buffer. */
          return (
            promoteQueuedPermission(finished, now, ctx, effects) ??
            withSpoken(finished, "Dettatura completata e inviata all'agente.")
          )
        } else {
          return (
            promoteQueuedPermission(finished, now, ctx, effects) ??
            withSpoken(finished, "Dettatura vuota, nessun messaggio inviato.")
          )
        }
      }

      // In dictation mode: accumulate speech chunks, NEVER parse as commands
      const updatedChunks = [...(state.dictation?.chunks ?? []), event.text.trim()]
      return {
        state: {
          ...state,
          dictation: {
            paneId: state.dictation?.paneId,
            chunks: updatedChunks,
          },
        },
        effects: [],
      }
    }

    return { state, effects: [] }
  }

  // 4. State: CONFIRMING
  if (state.status === "confirming") {
    if (event.type === "timeout") {
      effects.push({ type: "cancel_timer" })
      const expired: DialogState = {
        ...state,
        status: "idle",
        pendingAction: undefined,
        pendingPlan: undefined,
        timeoutAt: undefined,
      }
      return (
        promoteQueuedPermission(expired, now, ctx, effects) ??
        withSpoken(expired, "Non ho sentito risposta: lascio stare.")
      )
    }

    if (event.type === "cancel") {
      effects.push({ type: "cancel_timer" })
      const cancelled: DialogState = {
        ...state,
        status: "idle",
        pendingAction: undefined,
        pendingPlan: undefined,
        timeoutAt: undefined,
      }
      return (
        promoteQueuedPermission(cancelled, now, ctx, effects) ??
        withSpoken(cancelled, "Va bene, lascio stare.")
      )
    }

    if (event.type === "utterance") {
      /*
       * A planned plan (rilievo 4) sits here before `pendingAction`: the
       * planner asked to press Enter in an agent's tty, and the only answer
       * is yes or no. Negation vetoes before the parser, same as for a
       * destructive intent — and `pendingAction` may be undefined here, so
       * this branch never touches it.
       */
      if (state.pendingPlan) {
        if (hasNegation(normalizeUtterance(event.text))) {
          effects.push({ type: "cancel_timer" })
          const abandoned: DialogState = {
            ...state,
            status: "idle",
            pendingPlan: undefined,
            timeoutAt: undefined,
          }
          return (
            promoteQueuedPermission(abandoned, now, ctx, effects) ??
            withSpoken(abandoned, "Va bene, non invio niente.")
          )
        }

        const parsedPlan = parseUtterance(event.text, ctx)
        if (parsedPlan.intent?.intent === "dialog.confirm" || parsedPlan.intent?.intent === "permission.allow") {
          effects.push({ type: "cancel_timer" })
          effects.push({
            type: "execute_plan",
            steps: state.pendingPlan.steps,
            refusals: state.pendingPlan.refusals,
            ...(state.pendingPlan.speech ? { speech: state.pendingPlan.speech } : {}),
          })
          /*
           * Goes to `executing`, not idle: a permission queued behind this
           * confirmation waits for `command_success` / `command_failed`,
           * which are the exits from executing and the place it is promoted.
           */
          return withSpoken(
            {
              ...state,
              status: "executing",
              pendingPlan: undefined,
              pendingAction: undefined,
              timeoutAt: undefined,
            },
            "Eseguo il piano."
          )
        }
        if (parsedPlan.intent?.intent === "dialog.cancel" || parsedPlan.intent?.intent === "permission.deny") {
          effects.push({ type: "cancel_timer" })
          const refused: DialogState = {
            ...state,
            status: "idle",
            pendingPlan: undefined,
            timeoutAt: undefined,
          }
          return (
            promoteQueuedPermission(refused, now, ctx, effects) ??
            withSpoken(refused, "Va bene, non invio niente.")
          )
        }
        return withSpoken(state, "Sì o no?")
      }

      /*
       * A negation vetoes before the parser is even asked. «non confermo»
       * and «no, non va bene» used to reach the confirm branch because the
       * score only charged 0.15 for the extra word: the pane closed, or the
       * permission was granted, on an answer of no.
       */
      if (hasNegation(normalizeUtterance(event.text))) {
        effects.push({ type: "cancel_timer" })
        const action = state.pendingAction!
        const abandoned: DialogState = {
          ...state,
          status: "idle",
          pendingAction: undefined,
          timeoutAt: undefined,
        }

        if (action.isPermission && action.paneId) {
          effects.push({
            type: "answer_permission",
            paneId: action.paneId,
            answer: "deny",
          })
          return (
            promoteQueuedPermission(abandoned, now, ctx, effects) ??
            withSpoken(abandoned, "Permesso negato.")
          )
        }
        return (
          promoteQueuedPermission(abandoned, now, ctx, effects) ??
          withSpoken(abandoned, "Va bene, lascio stare.")
        )
      }

      const parsed = parseUtterance(event.text, {
        ...ctx,
        pendingPermission: state.pendingAction?.isPermission,
      })

      // Confirmation positive
      if (
        parsed.intent?.intent === "dialog.confirm" ||
        parsed.intent?.intent === "permission.allow"
      ) {
        effects.push({ type: "cancel_timer" })
        const action = state.pendingAction!

        if (action.isPermission && action.paneId) {
          effects.push({
            type: "answer_permission",
            paneId: action.paneId,
            answer: "allow",
          })
          const answered: DialogState = {
            ...state,
            status: "idle",
            pendingAction: undefined,
            timeoutAt: undefined,
          }
          return (
            promoteQueuedPermission(answered, now, ctx, effects) ??
            withSpoken(answered, "Permesso accordato.")
          )
        } else {
          effects.push({
            type: "execute_intent",
            intent: action.intent,
            slots: action.slots,
          })
          /*
           * Goes to `executing`, not idle: a permission queued behind this
           * confirmation waits for `command_success` / `command_failed`,
           * which are the exits from executing and the place it is promoted.
           */
          return withSpoken(
            {
              ...state,
              status: "executing",
              pendingAction: undefined,
              timeoutAt: undefined,
            },
            action.intent.readback
          )
        }
      }

      // Confirmation negative / cancellation
      if (
        parsed.intent?.intent === "dialog.cancel" ||
        parsed.intent?.intent === "permission.deny"
      ) {
        effects.push({ type: "cancel_timer" })
        const action = state.pendingAction!
        const refused: DialogState = {
          ...state,
          status: "idle",
          pendingAction: undefined,
          timeoutAt: undefined,
        }

        if (action.isPermission && action.paneId) {
          effects.push({
            type: "answer_permission",
            paneId: action.paneId,
            answer: "deny",
          })
          return (
            promoteQueuedPermission(refused, now, ctx, effects) ??
            withSpoken(refused, "Permesso negato.")
          )
        } else {
          return (
            promoteQueuedPermission(refused, now, ctx, effects) ??
            withSpoken(refused, "Va bene, lascio stare.")
          )
        }
      }

      // Unrecognized confirmation answer
      return withSpoken(
        state,
        "Sì o no?"
      )
    }

    return { state, effects: [] }
  }

  // 5. State: EXECUTING
  if (state.status === "executing") {
    if (event.type === "command_success" || event.type === "command_failed") {
      const finished: DialogState = { ...state, status: "idle" }
      /*
       * Executing is where a confirmation that said «sì» lands. The
       * permission queued behind that confirmation is asked here — the
       * only exit from executing that returns to an interactive state.
       */
      const promoted = promoteQueuedPermission(finished, now, ctx, effects)
      if (promoted) return promoted
      if (event.type === "command_failed") {
        // The dispatcher's sentence already says what went wrong, to the user:
        // «Errore durante l'esecuzione: Non c'è niente da annullare» said it twice.
        return withSpoken(finished, event.error)
      }
      return { state: finished, effects }
    }

    return { state, effects: [] }
  }

  // 6. State: IDLE / LISTENING
  if (state.status === "idle" || state.status === "listening") {
    if (event.type === "sleep") {
      return withSpoken({ ...state, status: "asleep" }, "Vado a dormire.")
    }

    if (event.type === "cancel") {
      return withSpoken(state, "Non c'è niente da fermare.")
    }

    if (event.type === "utterance") {
      const parsed = parseUtterance(event.text, ctx)

      if (parsed.outcome === "unknown") {
        return withSpoken(state, "Non ho capito, puoi ripetere?")
      }

      if (parsed.outcome === "ambiguous") {
        const first = parsed.candidates[0]?.intent.readback ?? "prima opzione"
        const second = parsed.candidates[1]?.intent.readback ?? "seconda opzione"
        return withSpoken(
          state,
          `Comando ambiguo. Intendi ${first.toLowerCase()} oppure ${second.toLowerCase()}?`
        )
      }

      const intent = parsed.intent!

      // Dialog controls
      if (intent.intent === "voice.sleep") {
        return withSpoken({ ...state, status: "asleep" }, "Vado a dormire.")
      }

      if (intent.intent === "dialog.repeat") {
        const textToRepeat =
          state.lastSpokenText ?? "Nessun messaggio precedente da ripetere."
        return withSpoken(state, textToRepeat)
      }

      // Dictation mode initiation
      if (intent.intent === "dictation.start") {
        const targetPane = parsed.slots.paneIndex ? String(parsed.slots.paneIndex) : undefined
        return withSpoken(
          {
            ...state,
            status: "dictating",
            dictation: {
              paneId: targetPane,
              chunks: [],
            },
          },
          intent.readback
        )
      }

      // Destructive intents require explicit confirmation
      if (intent.destructive) {
        const timeoutAt = now + DEFAULT_CONFIRMATION_TIMEOUT_MS
        effects.push({
          type: "start_timer",
          durationMs: DEFAULT_CONFIRMATION_TIMEOUT_MS,
          timeoutAt,
        })

        // The intent carries its own question. The fallback stays generic on
        // purpose: a wrong-sounding sentence at a destructive prompt is worse
        // than a plain one, and the readback is not a question.
        let question = intent.confirmPrompt ?? "Lo faccio, va bene?"

        /*
         * Rilievo 2: per un permesso la domanda deve nominare il pannello.
         * Lo slot di pannello è già stato estratto dalla frase («autorizza
         * pannello 2»); il titolo si legge dai pannelli aperti, così
         * l'utente conferma sapendo a chi concede.
         */
        if (intent.intent === "permission.allow") {
          const paneTitle =
            parsed.slots.paneTitle ??
            ctx.panes?.find((p) => p.index === parsed.slots.paneIndex)?.title
          if (paneTitle) {
            question = `Concedo il permesso all'agente sul pannello «${paneTitle}», va bene?`
          }
        }

        const prompt = `${question} Dimmi sì o no.`

        return withSpoken(
          {
            ...state,
            status: "confirming",
            timeoutAt,
            pendingAction: {
              intent,
              slots: parsed.slots,
              confirmPrompt: prompt,
              isPermission: false,
            },
          },
          prompt
        )
      }

      // Non-destructive intents execute directly
      effects.push({
        type: "execute_intent",
        intent,
        slots: parsed.slots,
      })

      return withSpoken(
        {
          ...state,
          status: "executing",
        },
        intent.readback
      )
    }
  }

  return { state, effects: [] }
}
