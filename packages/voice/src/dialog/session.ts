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
  /** For a permission: what the agent asked to do, as the question said it. */
  what?: string
  /**
   * For a permission promoted from the queue: no yes before this time (epoch
   * ms), the time its question takes to be read. V1-bis, ALTO 4: a second
   * yes said right after the first granted the promoted request while its
   * question was still being cut short by that very yes.
   */
  answerableAt?: number
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
  /**
   * A `send` the voice agent made into another session (rilievo 20), held in
   * confirming until the user says yes out loud. Without this the note reached
   * its target the moment the model wrote it — a message nobody ever saw.
   */
  pendingSend?: { id: string; to: string; text: string; lead?: string }
  /** A send that arrived while the dialogue was busy: promoted like a queued permission. */
  queuedSend?: { id: string; to: string; text: string; lead?: string }
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
  /** `what` is the request the question read: the host answers only that one (V1-bis, ALTO 3). */
  | { type: "answer_permission"; paneId: string; answer: "allow" | "deny"; what?: string }
  | { type: "send_prompt"; paneId?: string; text: string }
  | { type: "execute_plan"; steps: PlanStep[]; refusals: string[]; speech?: string }
  | { type: "confirm_send"; id: string; approved: boolean }

export type DialogEvent =
  | { type: "wake" }
  | { type: "sleep" }
  | { type: "utterance"; text: string }
  | { type: "permission_requested"; paneId: string; what: string; silent?: boolean }
  | { type: "permission_resolved"; paneId: string }
  /** `lead`: who wants to do what («La voce vuole chiedere a»); a note sent by the voice when absent (V1-bis, ALTO 8). */
  | { type: "send_requested"; id: string; to: string; text: string; lead?: string }
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

/*
 * V1-bis, ALTO 1: the answer to a question is a yes only when every word of it
 * is one. «sì però aspetta», «va bene, anzi», «confermo dopo» and even «va bene
 * la cena» used to confirm: the parser scored the yes and charged the rest as
 * surplus. A small closed set confirms, and nothing else does.
 */
const YES_WORDS: ReadonlySet<string> = new Set(["si", "conferma", "confermo", "procedi", "certo", "ok", "okay", "consenti"])

/** Words that turn an answer into a no wherever they appear: a yes with a «but» is not a yes. */
const VETO_WORDS: ReadonlySet<string> = new Set([
  "ma", "pero", "anzi", "dopo", "aspetta", "aspetto", "attendi", "momento",
  "stop", "fermo", "ferma", "fermati", "annulla", "wait", "nope", "cancel",
])

export type ConfirmationAnswer = "yes" | "no" | "unclear"

/** What an answer to a pending question says: a yes from the closed set, a veto, or neither. */
export function confirmationAnswer(text: string): ConfirmationAnswer {
  const norm = normalizeUtterance(text)
  if (!norm) return "unclear"
  const tokens = norm.split(/\s+/).filter(Boolean)
  if (hasNegation(norm) || tokens.some((token) => VETO_WORDS.has(token))) return "no"
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "va" && tokens[i + 1] === "bene") {
      i++
      continue
    }
    if (!YES_WORDS.has(tokens[i]!)) return "unclear"
  }
  return "yes"
}

/**
 * The pane an answer names, when it is a grant or a refusal with a pane in it
 * («consenti pannello 2», «autorizza beta», «nega pannello 2»). V1-bis, ALTO 2:
 * the pane named used to be ignored, and the pane being asked was answered.
 */
function namedPermissionPane(
  text: string,
  ctx: ParseContext,
): { paneId: string; answer: "allow" | "deny" } | undefined {
  const parsed = parseUtterance(text, ctx)
  const intent = parsed.intent?.intent
  if (intent !== "permission.allow" && intent !== "permission.deny") return undefined
  const { paneIndex, paneTitle } = parsed.slots
  const named =
    paneIndex !== undefined
      ? ctx.panes?.find((p) => p.index === Number(paneIndex))
      : paneTitle !== undefined
        ? ctx.panes?.find((p) => p.title.toLowerCase() === String(paneTitle).toLowerCase())
        : undefined
  if (!named) return undefined
  return { paneId: named.id, answer: intent === "permission.allow" ? "allow" : "deny" }
}

/** A refusal said in words the closed yes set does not cover: «lascia stare», «nega», «rifiuta». */
function saysRefusal(text: string, ctx: ParseContext): boolean {
  const intent = parseUtterance(text, ctx).intent?.intent
  return intent === "dialog.cancel" || intent === "permission.deny"
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
      what: req.what,
      answerableAt: now + readingMs(prompt),
    },
  }

  /* Silent meant "do not interrupt on arrival"; once the question is on
   * screen it must be read aloud, or it waits for a phrase nobody heard. */
  return withSpokenLocal(nextState, prompt, effects)
}

/**
 * How long a question takes to be read aloud: about 60 ms a character, never
 * under a second and a half. An estimate on the long side, so a yes said over
 * the question is not taken for a yes to it; one said after it always is.
 */
export function readingMs(text: string): number {
  return Math.min(12_000, Math.max(1_500, text.length * 60))
}

/** The question spoken for a voice-agent `send` waiting on a spoken yes (rilievo 20). */
function sendConfirmationPrompt(to: string, text: string, lead?: string): string {
  if (!lead) return `La voce vuole inviare a «${to}»: «${text}». Confermi l'invio?`
  return text.trim() ? `${lead} «${to}»: «${text}». Confermi?` : `${lead} «${to}». Confermi?`
}

/**
 * Promotes a send that arrived while the dialogue was busy, after the
 * permission queue has had its turn. Same contract as
 * {@link promoteQueuedPermission}: null when nothing is queued.
 */
function promoteQueuedSend(
  state: DialogState,
  now: number,
  effects: DialogEffect[],
): TransitionResult | null {
  const req = state.queuedSend
  if (!req) return null

  effects.push({ type: "cancel_timer" })
  const timeoutAt = now + DEFAULT_CONFIRMATION_TIMEOUT_MS
  effects.push({
    type: "start_timer",
    durationMs: DEFAULT_CONFIRMATION_TIMEOUT_MS,
    timeoutAt,
  })

  const nextState: DialogState = {
    ...state,
    status: "confirming",
    timeoutAt,
    queuedSend: undefined,
    pendingSend: { id: req.id, to: req.to, text: req.text, lead: req.lead },
    pendingAction: undefined,
    pendingPlan: undefined,
  }
  return withSpokenLocal(nextState, sendConfirmationPrompt(req.to, req.text, req.lead), effects)
}

/** Permissions first, then a waiting send: every exit path uses this. */
function promoteQueued(
  state: DialogState,
  now: number,
  ctx: ParseContext,
  effects: DialogEffect[],
): TransitionResult | null {
  return (
    promoteQueuedPermission(state, now, ctx, effects) ??
    promoteQueuedSend(state, now, effects)
  )
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

  /*
   * A note whose question is no longer being asked is refused, whatever
   * comes next (V1-bis, ALTO 7). Only `confirming` asks it; left behind in
   * any other state, a yes to the next question — «chiudi il pannello», a
   * permission — delivered it instead of doing what that yes was for.
   */
  if (state.pendingSend && state.status !== "confirming") {
    effects.push({ type: "confirm_send", id: state.pendingSend.id, approved: false })
    state = { ...state, pendingSend: undefined }
  }

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
  /*
   * A request answered elsewhere — by hand in the terminal, by a button, or
   * gone with its pane — leaves the dialogue: the question it was asked with
   * no longer has anything to answer, and a yes to it must not reach the next
   * request of the same pane (V1-bis, ALTO 3).
   */
  if (event.type === "permission_resolved") {
    const queued = state.queuedPermission?.paneId === event.paneId ? undefined : state.queuedPermission
    const asked = state.status === "confirming" && state.pendingAction?.isPermission && state.pendingAction.paneId === event.paneId
    if (!asked) return { state: { ...state, queuedPermission: queued }, effects: [] }
    effects.push({ type: "cancel_timer" })
    const closed: DialogState = { ...state, status: "idle", pendingAction: undefined, timeoutAt: undefined, queuedPermission: queued }
    const title = ctx.panes?.find((p) => p.id === event.paneId)?.title ?? event.paneId
    return promoteQueued(closed, now, ctx, effects) ?? withSpoken(closed, `Il pannello «${title}» ha già avuto la sua risposta.`)
  }

  if (event.type === "permission_requested") {
    /*
     * Rilievo 3: arriving during confirming, dictating or asleep used to
     * overwrite `pendingAction` (or yank a sleeping dialog into confirming).
     * The user's «sì» then answered the wrong question, and from sleep any
     * room noise could grant for 30 s. Queue instead: the busy state keeps
     * the floor; the permission is announced and promoted when it ends.
     */
    /* The pane being asked asks again: its new request replaces the question, it does not queue behind it. */
    const sameAsked =
      state.status === "confirming" && state.pendingAction?.isPermission === true && state.pendingAction.paneId === event.paneId
    if (
      !sameAsked &&
      (state.status === "confirming" || state.status === "dictating" || state.status === "asleep")
    ) {
      /* First in wins: a second arrival while one is already waiting does
       * not drop the first question on the floor. The same pane asking again
       * is not a second arrival: its newer request is the one on screen. */
      const queuedPermission =
        state.queuedPermission && state.queuedPermission.paneId !== event.paneId
          ? state.queuedPermission
          : { paneId: event.paneId, what: event.what, silent: event.silent }
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
        what: event.what,
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

  /*
   * A `send` the voice agent wrote into another session: preempts idle and
   * executing the same way a permission does, and queues behind an in-flight
   * confirmation, a dictation, or sleep (rilievo 20).
   */
  if (event.type === "send_requested") {
    if (
      state.status === "confirming" ||
      state.status === "dictating" ||
      state.status === "asleep"
    ) {
      /* First in wins: a second send while one waits does not drop the first. */
      const queuedSend = state.queuedSend ?? {
        id: event.id,
        to: event.to,
        text: event.text,
        lead: event.lead,
      }
      return withSpokenLocal(
        { ...state, queuedSend },
        `Ho messo in coda l'invio a «${event.to}». Lo affronto appena posso.`,
        effects,
      )
    }

    effects.push({ type: "cancel_timer" })
    const timeoutAt = now + DEFAULT_CONFIRMATION_TIMEOUT_MS
    effects.push({
      type: "start_timer",
      durationMs: DEFAULT_CONFIRMATION_TIMEOUT_MS,
      timeoutAt,
    })

    const nextState: DialogState = {
      ...state,
      status: "confirming",
      timeoutAt,
      pendingSend: { id: event.id, to: event.to, text: event.text, lead: event.lead },
      pendingAction: undefined,
      pendingPlan: undefined,
    }
    return withSpokenLocal(nextState, sendConfirmationPrompt(event.to, event.text, event.lead), effects)
  }

  // 2. State: ASLEEP
  if (state.status === "asleep") {
    if (event.type === "wake") {
      const woken = { ...state, status: "idle" as const }
      return (
        promoteQueued(woken, now, ctx, effects) ??
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
        promoteQueued(abandoned, now, ctx, effects) ??
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
            promoteQueued(finished, now, ctx, effects) ??
            withSpoken(finished, "Dettatura completata e inviata all'agente.")
          )
        } else {
          return (
            promoteQueued(finished, now, ctx, effects) ??
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
      /* A send left unanswered is not delivered: approved stays false. */
      if (state.pendingSend) {
        effects.push({
          type: "confirm_send",
          id: state.pendingSend.id,
          approved: false,
        })
        const expired: DialogState = {
          ...state,
          status: "idle",
          pendingSend: undefined,
          timeoutAt: undefined,
        }
        return (
          promoteQueued(expired, now, ctx, effects) ??
          withSpoken(expired, "Non ho sentito risposta: non invio niente.")
        )
      }
      const expired: DialogState = {
        ...state,
        status: "idle",
        pendingAction: undefined,
        pendingPlan: undefined,
        timeoutAt: undefined,
      }
      return (
        promoteQueued(expired, now, ctx, effects) ??
        withSpoken(expired, "Non ho sentito risposta: lascio stare.")
      )
    }

    if (event.type === "cancel") {
      effects.push({ type: "cancel_timer" })
      if (state.pendingSend) {
        effects.push({
          type: "confirm_send",
          id: state.pendingSend.id,
          approved: false,
        })
        const cancelled: DialogState = {
          ...state,
          status: "idle",
          pendingSend: undefined,
          timeoutAt: undefined,
        }
        return (
          promoteQueued(cancelled, now, ctx, effects) ??
          withSpoken(cancelled, "Va bene, non invio niente.")
        )
      }
      const cancelled: DialogState = {
        ...state,
        status: "idle",
        pendingAction: undefined,
        pendingPlan: undefined,
        timeoutAt: undefined,
      }
      return (
        promoteQueued(cancelled, now, ctx, effects) ??
        withSpoken(cancelled, "Va bene, lascio stare.")
      )
    }

    if (event.type === "utterance") {
      /*
       * A voice-agent send sits here before `pendingPlan` and
       * `pendingAction`: the only answer is yes or no, and negation vetoes
       * before the parser, same as for a destructive intent. The host is
       * holding the note until `confirm_send` says what the user decided.
       */
      if (state.pendingSend) {
        const answer = confirmationAnswer(event.text)
        if (answer === "no" || (answer === "unclear" && saysRefusal(event.text, ctx))) {
          effects.push({ type: "cancel_timer" })
          effects.push({
            type: "confirm_send",
            id: state.pendingSend.id,
            approved: false,
          })
          const abandoned: DialogState = {
            ...state,
            status: "idle",
            pendingSend: undefined,
            timeoutAt: undefined,
          }
          return (
            promoteQueued(abandoned, now, ctx, effects) ??
            withSpoken(abandoned, "Va bene, non invio niente.")
          )
        }

        if (answer === "yes") {
          effects.push({ type: "cancel_timer" })
          effects.push({
            type: "confirm_send",
            id: state.pendingSend.id,
            approved: true,
          })
          const approved: DialogState = {
            ...state,
            status: "idle",
            pendingSend: undefined,
            timeoutAt: undefined,
          }
          return (
            promoteQueued(approved, now, ctx, effects) ??
            withSpoken(approved, "Invio confermato.")
          )
        }
        return withSpoken(state, "Sì o no?")
      }

      /*
       * A planned plan (rilievo 4) sits here before `pendingAction`: the
       * planner asked to press Enter in an agent's tty, and the only answer
       * is yes or no. Negation vetoes before the parser, same as for a
       * destructive intent — and `pendingAction` may be undefined here, so
       * this branch never touches it.
       */
      if (state.pendingPlan) {
        const answer = confirmationAnswer(event.text)
        if (answer === "no" || (answer === "unclear" && saysRefusal(event.text, ctx))) {
          effects.push({ type: "cancel_timer" })
          const abandoned: DialogState = {
            ...state,
            status: "idle",
            pendingPlan: undefined,
            timeoutAt: undefined,
          }
          return (
            promoteQueued(abandoned, now, ctx, effects) ??
            withSpoken(abandoned, "Va bene, non invio niente.")
          )
        }

        if (answer === "yes") {
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
        return withSpoken(state, "Sì o no?")
      }

      /*
       * A negation vetoes before the parser is even asked. «non confermo»
       * and «no, non va bene» used to reach the confirm branch because the
       * score only charged 0.15 for the extra word: the pane closed, or the
       * permission was granted, on an answer of no.
       */
      let answer = confirmationAnswer(event.text)
      const parseCtx = { ...ctx, pendingPermission: state.pendingAction?.isPermission }

      /*
       * A pane named in the answer is the pane acted on (V1-bis, ALTO 2). The
       * one being asked is answered as said; another one with a request
       * waiting has its own question asked first — a grant is never given to
       * a question that was not read; a pane with nothing asked gets nothing.
       */
      const asked = state.pendingAction
      const named = answer === "unclear" && asked?.isPermission ? namedPermissionPane(event.text, ctx) : undefined
      if (named && asked?.paneId && named.paneId === asked.paneId) {
        answer = named.answer === "allow" ? "yes" : "no"
      } else if (named && asked?.paneId) {
        const title = (id: string) => ctx.panes?.find((p) => p.id === id)?.title ?? id
        if (state.queuedPermission?.paneId === named.paneId) {
          const aside = { paneId: asked.paneId, what: asked.what ?? "" }
          const promoted = promoteQueuedPermission(state, now, ctx, effects)!
          return { ...promoted, state: { ...promoted.state, queuedPermission: aside } }
        }
        return withSpoken(
          state,
          `Il pannello «${title(named.paneId)}» non ha richieste aperte. Sto chiedendo del pannello «${title(asked.paneId)}»: sì o no?`,
        )
      }

      /*
       * A promoted question not yet read whole is not answered yes: the yes
       * was said over it, most likely meant for the question before. It is
       * read again, and the wait starts over. A no is taken at once.
       */
      if (answer === "yes" && asked?.answerableAt !== undefined && now < asked.answerableAt) {
        const again: DialogState = {
          ...state,
          pendingAction: { ...asked, answerableAt: now + readingMs(asked.confirmPrompt) },
        }
        return withSpoken(again, asked.confirmPrompt)
      }

      if (answer === "no" || (answer === "unclear" && saysRefusal(event.text, parseCtx))) {
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
            what: action.what,
          })
          return (
            promoteQueued(abandoned, now, ctx, effects) ??
            withSpoken(abandoned, "Permesso negato.")
          )
        }
        return (
          promoteQueued(abandoned, now, ctx, effects) ??
          withSpoken(abandoned, "Va bene, lascio stare.")
        )
      }

      // Confirmation positive: only a yes from the closed set.
      if (answer === "yes") {
        effects.push({ type: "cancel_timer" })
        const action = state.pendingAction!

        if (action.isPermission && action.paneId) {
          effects.push({
            type: "answer_permission",
            paneId: action.paneId,
            answer: "allow",
            what: action.what,
          })
          const answered: DialogState = {
            ...state,
            status: "idle",
            pendingAction: undefined,
            timeoutAt: undefined,
          }
          return (
            promoteQueued(answered, now, ctx, effects) ??
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
      const promoted = promoteQueued(finished, now, ctx, effects)
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
         *
         * Rilievo 21: lo stesso vale per chiudere un pannello e fermarne il
         * processo — «Chiudo il pannello, va bene?» senza il nome lasciava
         * confermare al buio quando più sessioni erano aperte.
         */
        const confirmPaneTitle =
          parsed.slots.paneTitle ??
          ctx.panes?.find((p) => p.index === parsed.slots.paneIndex)?.title

        if (intent.intent === "permission.allow") {
          if (confirmPaneTitle) {
            question = `Concedo il permesso all'agente sul pannello «${confirmPaneTitle}», va bene?`
          }
        } else if (intent.intent === "pane.close" && confirmPaneTitle) {
          question = `Chiudo il pannello «${confirmPaneTitle}», va bene?`
        } else if (intent.intent === "process.kill" && confirmPaneTitle) {
          question = `Fermo il processo sul pannello «${confirmPaneTitle}», va bene?`
        }

        const prompt = `${question} Dimmi sì o no.`

        /*
         * Rilievo 22: senza numero o titolo il bersaglio era il pannello a
         * fuoco, ma letto al «sì» — un clic nel frattempo spostava la
         * chiusura su un'altra sessione. Il fuoco di adesso entra negli slot
         * come `paneId`, così il dispatch lo usa al posto del fuoco vivo.
         * Con un bersaglio già nominato lo slot non serve: index e titolo
         * vincono comunque nel resolver.
         */
        const frozenSlots: Record<string, any> = { ...parsed.slots }
        const hasNamedTarget =
          frozenSlots.paneId !== undefined ||
          frozenSlots.paneIndex !== undefined ||
          frozenSlots.paneTitle !== undefined
        if (!hasNamedTarget && ctx.focusedPaneId) {
          frozenSlots.paneId = ctx.focusedPaneId
        }

        return withSpoken(
          {
            ...state,
            status: "confirming",
            timeoutAt,
            pendingAction: {
              intent,
              slots: frozenSlots,
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
