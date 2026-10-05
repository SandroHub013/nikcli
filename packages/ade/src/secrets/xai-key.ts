/**
 * The xAI key of the streaming transcription, as an entry of the keychain.
 *
 * Same scheme as the voice's OpenRouter key (`voice-key.ts`): «xAI», variable
 * `XAI_API_KEY`, given to no agent. Unlike that one, its value never comes back
 * to the page: `stt_stream_open` reads it in Rust, and the page knows only the
 * masked tail the keychain lists. Plain `.ts`, tested under `bun test`.
 */

import type { KeyDraft, KeyInfo } from "./keys"
import { freeKeyName } from "./voice-key"

/** The variable `stt_stream.rs` reads. */
export const XAI_KEY_ENV = "XAI_API_KEY"
/** Its name on the Chiavi API page, when the page is the one that creates it. */
export const XAI_KEY_NAME = "xAI"

/** The entry the transcription uses: the one whose variable is `XAI_API_KEY`. */
export function xaiKeyEntry(keys: readonly KeyInfo[]): KeyInfo | undefined {
  return keys.find((key) => key.env === XAI_KEY_ENV)
}

/** What to save for `value`: over the existing entry, keeping its name and agents, or a new «xAI» for no agent. */
export function xaiKeyDraft(keys: readonly KeyInfo[], value: string): KeyDraft {
  const entry = xaiKeyEntry(keys)
  return {
    name: entry?.name ?? freeKeyName(keys, XAI_KEY_NAME),
    env: XAI_KEY_ENV,
    agents: entry ? [...entry.agents] : [],
    value: value.trim(),
  }
}

/**
 * What the page says of a saved key: refused by xAI, used by the transcription,
 * or unused because the transcription is on MAI-Transcribe-2.
 */
export type XaiKeyUse = "used" | "refused" | "idle"

export function xaiKeyUse(input: { streaming: boolean; refused: boolean }): XaiKeyUse {
  if (input.refused) return "refused"
  return input.streaming ? "used" : "idle"
}

/** What ADE does to the voice when the xAI entry changes. */
export interface XaiKeyEffects {
  /** `voiceEngine.retryStream()`: lifts a refusal or a pause on the open transcriber. */
  retryStream: () => void
  /** The page's state line goes back to «attivo» until the transcriber says otherwise. */
  markReady: () => void
  /** Closes the socket open right now (`sttTransport.cancel()`). */
  cancelSocket: () => void
  /** Reads the masked tail again for Riconoscimento. */
  refresh: () => void
}

/**
 * A new key lifts a refusal; a removed one closes the open socket and then
 * lifts the pause that closing it would leave behind: cut under a `send`, the
 * socket reads as a network failure, and a key saved a minute later (from
 * outside this page) would wait out a pause it never earned (review T5b, B1).
 */
export function xaiKeyChanged(change: "saved" | "removed", effects: XaiKeyEffects): void {
  if (change === "removed") effects.cancelSocket()
  effects.retryStream()
  effects.markReady()
  effects.refresh()
}

/**
 * Reads the keychain again while settings are open: when the window comes back
 * to the front, and every `everyMs`. A key saved from outside this page (another
 * window, a terminal) shows up without reopening it (review T5b, B3). Returns
 * the stop.
 */
export function watchKeychain(
  refresh: () => void,
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  everyMs = 30_000,
): () => void {
  const onFocus = () => refresh()
  target.addEventListener("focus", onFocus)
  const timer = setInterval(refresh, everyMs)
  return () => {
    target.removeEventListener("focus", onFocus)
    clearInterval(timer)
  }
}
