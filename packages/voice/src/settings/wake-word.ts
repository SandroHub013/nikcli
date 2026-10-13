/**
 * Wake-word detection and extraction logic for partial and final ASR streams.
 *
 * Reuses the canonical normalization (normalizeUtterance). The name is matched
 * exactly, in the spellings the recogniser writes it ("ragù", "ragu", "ragú", "rago", "ragoo").
 */

import { normalizeUtterance } from "../intent/normalize"

export interface WakeWordMatch {
  /** Whether the wake-word sequence was detected. */
  readonly matched: boolean
  /** The remaining command utterance following the detected wake word. */
  readonly remainder: string
}

/**
 * Phonetic equivalences for common speech-to-text misrecognitions in Italian.
 */
const WAKE_WORD_PHONETIC_ALIASES: Readonly<Record<string, readonly string[]>> = {
  hei: ["hei", "ehi", "hey", "ei", "he", "eh"],
  ehi: ["hei", "ehi", "hey", "ei", "he", "eh"],
  hey: ["hei", "ehi", "hey", "ei", "he", "eh"],
  ei: ["hei", "ehi", "hey", "ei", "he", "eh"],
  ragu: ["ragu", "ragù", "ragú", "rago", "ragoo"],
  ragù: ["ragu", "ragù", "ragú", "rago", "ragoo"],
  ragú: ["ragu", "ragù", "ragú", "rago", "ragoo"],
  rago: ["ragu", "ragù", "ragú", "rago", "ragoo"],
  ragoo: ["ragu", "ragù", "ragú", "rago", "ragoo"],
}

function matchToken(utteranceToken: string, wakeToken: string): boolean {
  if (utteranceToken === wakeToken) {
    return true
  }

  const aliases = WAKE_WORD_PHONETIC_ALIASES[wakeToken]
  if (aliases && aliases.includes(utteranceToken)) {
    return true
  }

  /*
   * Nothing approximate. We accept only the actual ASR spellings for «ragù»
   * (ragu, ragù, ragú, rago, ragoo) and greetings.
   */
  return false
}

/**
 * What people put in front of the name, and which is not part of it.
 *
 * "Ragù, apri il browser" and "ehi ragù, apri il browser" are the same request.
 * Only these may come first: the name has to open the sentence, otherwise the
 * television saying "ragù" halfway through a line would be an address.
 */
const OPENERS: ReadonlySet<string> = new Set(["hei", "ehi", "hey", "ei", "eh", "e"])

/*
 * «e» and «eh» are how the recogniser often writes «ei», and also how a
 * sentence about ragù begins: «E il ragù ha detto che…» from the
 * television. With these in front, the name counts only on its own or with a
 * pause after it, which the recogniser writes as punctuation. No guessing
 * from the words that follow: that went wrong both ways.
 */
const WEAK_OPENERS: ReadonlySet<string> = new Set(["e", "eh"])

/** Whether «e ragù …» has no pause after the name, and so may be about ragù. */
function noPauseAfterName(utterance: string): boolean {
  // «ehragu,»: the recogniser may glue the greeting to the name.
  // Inspect the first name only; punctuation after a later mention is not its pause.
  const name = /(?:\b|(?<=\beh?))rag(?:u|ù|ú|o|oo)\b(\s*[,.;:!?…])?/iu.exec(utterance)
  return !name?.[1]
}

/*
 * «ei ragù» written as one word, which the recogniser does when it is said
 * quickly: «eiragu», «heyragu», «heyragoo». Split back into greeting and name.
 */
const JOINED = /^(hei|ehi|hey|ei|eh)(ragu|ragù|ragú|rago|ragoo)$/

function splitJoined(token: string): string[] {
  const joined = JOINED.exec(token)
  return joined ? [joined[1], joined[2]] : [token]
}

/**
 * Inspects a spoken utterance for the configured name, at its start.
 *
 * Guarantees:
 * - Detects "ei ragù" across ASR misrecognitions: "ragù", "ragu", "ragú", "rago", "ragoo",
 *   with greeting variations ("ehi ragù", "hey ragoo", "eiragu").
 * - Never triggers when the name is part of a longer word (e.g. "ragusano").
 * - Never triggers on a name buried in the middle of a sentence, which is what
 *   a radio or a conversation in the room sounds like.
 * - Never triggers on "ragù" alone without "ei" / greeting.
 * - Returns what remains of the utterance after the name, enabling single-shot commands.
 */
export function matchesWakeWord(utterance: string, wakeWord: string): WakeWordMatch {
  const normUtterance = normalizeUtterance(utterance)
  const normWake = normalizeUtterance(wakeWord)

  if (!normUtterance || !normWake) {
    return { matched: false, remainder: "" }
  }

  const uTokens = normUtterance.split(/\s+/).filter(Boolean).flatMap(splitJoined)
  const wTokens = normWake.split(/\s+/).filter(Boolean)

  if (uTokens.length < wTokens.length) {
    return { matched: false, remainder: "" }
  }

  /*
   * Only from the start, past any greeting. This used to scan the whole
   * sentence, so "domani il ragù della squadra" woke the assistant up.
   */
  let start = 0
  while (start < uTokens.length && OPENERS.has(uTokens[start]) && !matchToken(uTokens[start], wTokens[0])) {
    start++
  }

  for (let i = start; i <= Math.min(start, uTokens.length - wTokens.length); i++) {
    let allMatched = true
    for (let j = 0; j < wTokens.length; j++) {
      if (!matchToken(uTokens[i + j], wTokens[j])) {
        allMatched = false
        break
      }
    }

    if (allMatched) {
      const remainder = uTokens
        .slice(i + wTokens.length)
        .join(" ")
        .trim()
      if (i > 0 && WEAK_OPENERS.has(uTokens[i - 1]!) && remainder && noPauseAfterName(utterance)) {
        return { matched: false, remainder: "" }
      }
      return {
        matched: true,
        remainder,
      }
    }
  }

  return { matched: false, remainder: "" }
}
