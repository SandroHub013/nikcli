/**
 * Wake-word detection and extraction logic for partial and final ASR streams.
 *
 * Reuses existing canonical normalization (normalizeUtterance) and ADE fuzzy matching (fuzzyMatch)
 * to tolerate real-world speech recognition phonetic variations ("ehi nik", "hey nick", "ei nik")
 * without triggering on substrings embedded within longer words.
 */

import { fuzzyMatch } from "@nikcli-ai/ade/command/match"
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
  nik: ["nik", "nick", "nic"],
  nick: ["nik", "nick", "nic"],
  nic: ["nik", "nick", "nic"],
}

function matchToken(utteranceToken: string, wakeToken: string): boolean {
  if (utteranceToken === wakeToken) {
    return true
  }

  const aliases = WAKE_WORD_PHONETIC_ALIASES[wakeToken]
  if (aliases && aliases.includes(utteranceToken)) {
    return true
  }

  // Safe fuzzy match: strictly restrict length difference to at most 1 character
  // so embedded substrings in longer words (e.g. "nikopolis", "scheinik") never match.
  if (Math.abs(utteranceToken.length - wakeToken.length) <= 1) {
    const fwd = fuzzyMatch(utteranceToken, wakeToken)
    const rev = fuzzyMatch(wakeToken, utteranceToken)
    if ((fwd && fwd.score > 10) || (rev && rev.score > 10)) {
      return true
    }
  }

  return false
}

/**
 * Inspects a partial or final spoken utterance for the configured wake-phrase.
 *
 * Guarantees:
 * - Detects "hei nik" across ASR misrecognitions: "ehi nik", "hey nick", "ei nik".
 * - Never triggers when the wake-word is part of a longer word (e.g. "nikopolis").
 * - Returns what remains of the utterance after the wake-phrase, enabling single-shot commands.
 */
export function matchesWakeWord(
  utterance: string,
  wakeWord: string
): WakeWordMatch {
  const normUtterance = normalizeUtterance(utterance)
  const normWake = normalizeUtterance(wakeWord)

  if (!normUtterance || !normWake) {
    return { matched: false, remainder: "" }
  }

  const uTokens = normUtterance.split(/\s+/).filter(Boolean)
  const wTokens = normWake.split(/\s+/).filter(Boolean)

  if (uTokens.length < wTokens.length) {
    return { matched: false, remainder: "" }
  }

  for (let i = 0; i <= uTokens.length - wTokens.length; i++) {
    let allMatched = true
    for (let j = 0; j < wTokens.length; j++) {
      if (!matchToken(uTokens[i + j], wTokens[j])) {
        allMatched = false
        break
      }
    }

    if (allMatched) {
      const remainder = uTokens.slice(i + wTokens.length).join(" ").trim()
      return {
        matched: true,
        remainder,
      }
    }
  }

  return { matched: false, remainder: "" }
}
