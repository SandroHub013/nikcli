/**
 * The voice's OpenRouter key, as an entry of the keychain.
 *
 * It used to live in the WebView2 profile's `localStorage`, plaintext on disk,
 * typed into the voice's own field; ADE's other keys were in the system
 * keychain, on the Chiavi API page. Since S6 it is one of those: «OpenRouter»,
 * variable `OPENROUTER_API_KEY`, given to no agent. The voice still needs the
 * value in the page, because transcription and MAI speak to OpenRouter from
 * here; it gets it from `secret_voice_key`, which reads that one variable and
 * refuses any other (`secrets.rs`), and keeps it in memory only.
 *
 * Plain `.ts`, with the host and the old storage injected, so the move is
 * tested under `bun test` without a keychain.
 */

import type { KeyDraft, KeyInfo } from "./keys"

/** The variable the voice's key becomes: the only one the page can read back. */
export const VOICE_KEY_ENV = "OPENROUTER_API_KEY"
/** Its name on the Chiavi API page, when the voice is the one that creates it. */
export const VOICE_KEY_NAME = "OpenRouter"

export interface VoiceKeyHost {
  list: () => Promise<readonly KeyInfo[]>
  save: (draft: KeyDraft) => Promise<void>
  remove: (name: string) => Promise<void>
  /** `secret_voice_key`: the value of the `OPENROUTER_API_KEY` entry, undefined without one. */
  read: () => Promise<string | undefined>
}

/** Where the key was before S6: the voice's slot in browser storage. */
export interface LegacyVoiceKey {
  read: () => string | undefined
  clear: () => void
}

export type VoiceKeyMigration =
  /** Nothing in the old place. */
  | { kind: "none" }
  /** Copied into the keychain, then taken out of the old place. */
  | { kind: "moved" }
  /** The keychain already had the same key: the old copy is gone. */
  | { kind: "same" }
  /** The keychain has another key: the old one waits for the user's answer, on the Chiavi API page. */
  | { kind: "conflict" }
  /** The keychain refused the copy: the old place keeps it, and the next start tries again. */
  | { kind: "failed"; reason: string }

const reasonOf = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure))

/** The entry the voice reads: the one whose variable is `OPENROUTER_API_KEY`. */
export function voiceKeyEntry(keys: readonly KeyInfo[]): KeyInfo | undefined {
  return keys.find((key) => key.env === VOICE_KEY_ENV)
}

/**
 * A name for a new entry that no other key has: «OpenRouter», or «OpenRouter 2»…
 * A key the user already called «OpenRouter» for another variable is theirs, and
 * saving under its name would turn it into this one.
 */
export function freeVoiceKeyName(keys: readonly KeyInfo[]): string {
  return freeKeyName(keys, VOICE_KEY_NAME)
}

/** `base`, or `base 2`, `base 3`…: the first name no key has. */
export function freeKeyName(keys: readonly KeyInfo[], base: string): string {
  const taken = new Set(keys.map((key) => key.name))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

/**
 * Saves `value` as the voice's key: over the existing entry, keeping its name
 * and its agents, or as a new «OpenRouter» given to no agent.
 */
export async function saveVoiceKey(host: VoiceKeyHost, value: string): Promise<void> {
  const keys = await host.list()
  const entry = voiceKeyEntry(keys)
  await host.save({
    name: entry?.name ?? freeVoiceKeyName(keys),
    env: VOICE_KEY_ENV,
    agents: entry ? [...entry.agents] : [],
    value,
  })
}

/**
 * Moves the key out of browser storage, once, at start.
 *
 * Copy first, delete after: the old copy goes only once the keychain has said
 * yes, so a refusal leaves the user with the key they had. When the keychain
 * already holds a different key, neither is chosen here — the old one stays
 * until the user answers on the Chiavi API page (`resolveVoiceKeyConflict`).
 */
export async function migrateVoiceKey(host: VoiceKeyHost, legacy: LegacyVoiceKey): Promise<VoiceKeyMigration> {
  const old = legacy.read()?.trim()
  if (!old) return { kind: "none" }
  try {
    const keys = await host.list()
    const entry = voiceKeyEntry(keys)
    const current = entry ? await host.read() : undefined
    if (entry && current) {
      if (current === old) {
        legacy.clear()
        return { kind: "same" }
      }
      return { kind: "conflict" }
    }
    // No entry, or one whose value the keychain lost: the voice's key fills it.
    await saveVoiceKey(host, old)
    legacy.clear()
    return { kind: "moved" }
  } catch (failure) {
    return { kind: "failed", reason: reasonOf(failure) }
  }
}

/** The user's answer to the conflict: the voice's key goes into the keychain, or the keychain's stays. */
export async function resolveVoiceKeyConflict(
  host: VoiceKeyHost,
  legacy: LegacyVoiceKey,
  choice: "voice" | "keychain",
): Promise<void> {
  const old = legacy.read()?.trim()
  if (choice === "voice" && old) await saveVoiceKey(host, old)
  legacy.clear()
}
