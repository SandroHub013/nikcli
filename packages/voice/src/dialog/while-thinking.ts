/**
 * What a sentence heard while the assistant is still thinking should do.
 *
 * A new sentence used to stop the turn whatever it was, and with the mic open
 * that includes the television: a line of dialogue from the next room ended a
 * question the user was waiting on. Only two things may end a turn now — a
 * request to stop, and a real new request — and everything else is shown as
 * ignored and left alone.
 *
 * Typed text is always meant: nobody types noise. Heard text has to earn it.
 */

import { normalizeAccents } from "../intent/normalize"
import type { ParseResult } from "../intent/parse"

export type WhileThinking = { action: "stop" } | { action: "request" } | { action: "ignore"; reason: string }

/** Below this, the recogniser itself is not sure what was said. */
export const MIN_CONFIDENCE = 0.6

/** Fewer words than this, not naming a command, is not a request. */
const MIN_WORDS = 3

const STOP = /^(?:annulla(?: tutto)?|stop|basta|fermati|ferma(?: tutto)?|lascia (?:stare|perdere)|smetti)$/

/* Sounds people make while listening, and what the grammar reads as an answer to a question nobody asked. */
const FILLER = /^(?:ok(?:ay)?|s[iì]|no|mh+|m+|eh+|ah+|uh+|ehm|boh|gi[aà]|vabb?[eè]|va bene|grazie|certo|perfetto|bene|ciao)$/

const NOT_REQUESTS = new Set(["dialog.confirm", "dialog.cancel", "dialog.repeat"])

export function triageWhileThinking(
  parsed: ParseResult,
  heard: { typed: boolean; confidence?: number },
): WhileThinking {
  // From what was said, not the parser's form of it, which turns words into numbers and drops some.
  const text = normalizeAccents(parsed.rawUtterance.toLowerCase())
    .replace(/[.,;:!?…"«»]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const intent = parsed.outcome === "matched" ? parsed.intent?.intent : undefined

  if (STOP.test(text)) return { action: "stop" }
  if (heard.typed) return intent === "dialog.cancel" ? { action: "stop" } : { action: "request" }

  if (heard.confidence !== undefined && heard.confidence < MIN_CONFIDENCE) {
    return { action: "ignore", reason: "riconoscimento incerto" }
  }
  if (text.length === 0 || FILLER.test(text)) return { action: "ignore", reason: "non è una richiesta" }
  if (intent && !NOT_REQUESTS.has(intent)) return { action: "request" }
  if (text.split(" ").length < MIN_WORDS) return { action: "ignore", reason: "troppo breve" }
  return { action: "request" }
}
