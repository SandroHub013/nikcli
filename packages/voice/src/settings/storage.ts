/**
 * LocalStorage persistence adapter for voice configuration.
 *
 * Provides safe, guarded access to browser storage:
 * - Single root storage key ("voice.settings")
 * - Immune to SecurityError and QuotaExceededError in private browsing contexts
 * - Always passes data through normalizeSettings before reading or writing
 */

import {
  DEFAULT_VOICE_SETTINGS,
  normalizeSettings,
  REPLY_BACKEND_BY_VOICE,
  REPLY_VOICES,
  type NormalizedVoiceSettings,
  type ReplyVoice,
  type VoiceSettings,
} from "./model"
import { t } from "@nikcli-ai/ade/i18n"

export const VOICE_SETTINGS_STORAGE_KEY = "voice.settings"

/**
 * Where the OpenRouter key used to be kept: read now only to move it out.
 *
 * It was a field of the settings blob, then a slot of its own in browser
 * storage — plaintext in the WebView2 profile on disk either way. Since S6 it
 * is an entry of the system keychain («OpenRouter», `OPENROUTER_API_KEY`), on
 * ADE's Chiavi API page. The host moves what it finds here into the keychain
 * (`readLegacyOpenRouterKey`, `clearLegacyOpenRouterKey`) and fills
 * `settings.openRouterApiKey` in memory; this file never writes a key again.
 */
export const VOICE_API_KEY_STORAGE_KEY = "voice.openrouter.key"
export const VOICE_OPENROUTER_KEY_REMOVED_STORAGE_KEY = "voice.openrouter.keyRemoved"

/** The browser's storage, or nothing where there is none: see `resolveStorage`. */
export function voiceStorage(customStorage?: Storage): Storage | null {
  return resolveStorage(customStorage)
}

function resolveStorage(customStorage?: Storage): Storage | null {
  if (customStorage) return customStorage
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage
    }
  } catch {
    // LocalStorage access may be restricted in private/sandboxed windows
  }
  return null
}

/**
 * Reads voice settings from persistent storage.
 *
 * Guarantees: Never throws. Falls back to normalized default settings on failure.
 */
/**
 * `testIdentity` is ADE Test: a new profile there starts on Piper, and no
 * stored voice that spends a key is read (see `normalizeSettings`).
 */
export interface VoiceSettingsLoadOptions {
  readonly testIdentity?: boolean
}

export function loadVoiceSettings(storage?: Storage, options?: VoiceSettingsLoadOptions): NormalizedVoiceSettings {
  const store = resolveStorage(storage)
  if (!store) {
    return normalizeSettings(null, options)
  }

  try {
    const raw = store.getItem(VOICE_SETTINGS_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null

    /*
     * The key is not a setting any more: it is in the keychain, and the host
     * puts it in memory. One written inline by a profile older than the slot
     * is moved to the slot before the blob can be written back without it,
     * so the host's move to the keychain still finds it.
     */
    const inline =
      typeof parsed === "object" && parsed !== null && "openRouterApiKey" in parsed
        ? (parsed as { openRouterApiKey?: unknown }).openRouterApiKey
        : undefined
    if (typeof inline === "string" && inline.trim() && !safeRead(store, VOICE_API_KEY_STORAGE_KEY)) {
      store.setItem(VOICE_API_KEY_STORAGE_KEY, inline.trim())
    }
    let merged: Record<string, unknown> | null = null
    if (typeof parsed === "object" && parsed !== null) {
      const { openRouterApiKey: _inline, ...rest } = parsed as Record<string, unknown>
      merged = rest
    } else if (parsed !== null) {
      merged = {}
    }

    // New is nothing stored at all: a stored `{}` next to a key is a profile, and keeps Ugo.
    const normalized = normalizeSettings(merged, { ...options, fresh: parsed === null })

    /*
     * A profile the loader had to migrate is written back at once.
     *
     * Otherwise the migration runs again at every start: the stored blob keeps
     * the old version, and the sentence explaining what changed is shown to
     * the user each time as though it had just happened.
     */
    const storedVersion =
      typeof parsed === "object" && parsed !== null ? (parsed as { version?: unknown }).version : undefined
    // Also a profile of the current version that a migration still moved (a backend that was removed
    // after it was written): without the write it is moved, and told, at every start.
    if (merged !== null && (storedVersion !== normalized.settings.version || normalized.migrations.length > 0)) {
      writeSettings(store, persisted(normalized.settings, replyVoiceOf(parsed), options))
    }

    return normalized
  } catch {
    return normalizeSettings(null, options)
  }
}

/**
 * What is written, under ADE Test.
 *
 * ADE Test reads a voice that spends a key as Ugo (`normalizeSettings`), and
 * that is a reading, not a choice. Written back, it would put Ugo over the
 * user's Rosa the first time a test build opened the profile, so the MAI voice
 * the profile named, or the one a save asked for, is written as it was.
 */
function persisted(settings: VoiceSettings, intended: unknown, options?: VoiceSettingsLoadOptions): VoiceSettings {
  if (!options?.testIdentity) return settings
  const voice = intended as ReplyVoice
  if (!REPLY_VOICES.includes(voice) || REPLY_BACKEND_BY_VOICE[voice] !== "mai") return settings
  return { ...settings, replyVoice: voice, replyBackend: "mai" }
}

function replyVoiceOf(parsed: unknown): unknown {
  return typeof parsed === "object" && parsed !== null ? (parsed as { replyVoice?: unknown }).replyVoice : undefined
}

function storedReplyVoice(store: Storage): unknown {
  try {
    const raw = store.getItem(VOICE_SETTINGS_STORAGE_KEY)
    return replyVoiceOf(raw ? JSON.parse(raw) : null)
  } catch {
    return undefined
  }
}

/** Writes the blob, never with the credential in it. Never throws. */
function writeSettings(store: Storage, settings: VoiceSettings): boolean {
  try {
    const { openRouterApiKey: _key, ...withoutKey } = settings
    store.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify(withoutKey))
    return true
  } catch {
    return false
  }
}

/** The key a profile from before S6 kept in browser storage, or undefined: for the host's move to the keychain. */
export function readLegacyOpenRouterKey(storage = voiceStorage()): string | undefined {
  if (!storage) return undefined
  const slot = safeRead(storage, VOICE_API_KEY_STORAGE_KEY).trim()
  if (slot) return slot
  try {
    const raw = storage.getItem(VOICE_SETTINGS_STORAGE_KEY)
    const inline = raw ? (JSON.parse(raw) as { openRouterApiKey?: unknown }).openRouterApiKey : undefined
    return typeof inline === "string" && inline.trim() ? inline.trim() : undefined
  } catch {
    return undefined
  }
}

/** Takes the old key out of browser storage, slot and blob both: once the keychain has it, or the user chose the keychain's. */
export function clearLegacyOpenRouterKey(storage = voiceStorage()): void {
  if (!storage) return
  try {
    storage.removeItem(VOICE_API_KEY_STORAGE_KEY)
    const raw = storage.getItem(VOICE_SETTINGS_STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
    if (parsed && typeof parsed === "object" && "openRouterApiKey" in parsed) {
      const { openRouterApiKey: _key, ...rest } = parsed
      storage.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify(rest))
    }
  } catch {
    return
  }
}

function safeRead(store: Storage, key: string): string {
  try {
    return store.getItem(key) ?? ""
  } catch {
    return ""
  }
}

export function isOpenRouterKeyRemoved(storage = voiceStorage()): boolean {
  return !!storage && safeRead(storage, VOICE_OPENROUTER_KEY_REMOVED_STORAGE_KEY) === "1"
}

export function markOpenRouterKeyRemoved(storage = voiceStorage()): void {
  if (!storage) return
  try {
    storage.setItem(VOICE_OPENROUTER_KEY_REMOVED_STORAGE_KEY, "1")
  } catch {
    return
  }
}

export function clearOpenRouterKeyRemoved(storage = voiceStorage()): void {
  if (!storage) return
  try {
    storage.removeItem(VOICE_OPENROUTER_KEY_REMOVED_STORAGE_KEY)
  } catch {
    return
  }
}

/**
 * Saves voice settings to persistent storage after normalization.
 *
 * Guarantees: Never throws. Returns the normalized settings that were stored
 * or recovered.
 */
export function saveVoiceSettings(
  patch: Partial<VoiceSettings>,
  storage?: Storage,
  options?: VoiceSettingsLoadOptions,
): NormalizedVoiceSettings {
  // The same identity as the load: in ADE Test, a first save must not write the new profile's Rosa to disk.
  const current = loadVoiceSettings(storage, options)
  const merged = { ...current.settings, ...patch }
  const normalized = normalizeSettings(merged, options)

  const store = resolveStorage(storage)
  if (!store) {
    return {
      ...normalized,
      corrections: [...normalized.corrections, t("vui.fix.noStorage")],
    }
  }

  const intended = "replyVoice" in patch ? patch.replyVoice : storedReplyVoice(store)
  if (writeSettings(store, persisted(normalized.settings, intended, options))) {
    return normalized
  }
  return {
    ...normalized,
    corrections: [...normalized.corrections, t("vui.fix.saveFailed")],
  }
}

/**
 * Clears persistent settings from storage and returns default settings.
 */
export function resetVoiceSettings(storage?: Storage, options?: VoiceSettingsLoadOptions): NormalizedVoiceSettings {
  const store = resolveStorage(storage)
  if (store) {
    try {
      store.removeItem(VOICE_SETTINGS_STORAGE_KEY)
      // An old key still waiting to be moved goes too; the keychain's is not the voice's to reset.
      store.removeItem(VOICE_API_KEY_STORAGE_KEY)
    } catch {
      // ignore
    }
  }
  return normalizeSettings(DEFAULT_VOICE_SETTINGS, options)
}

/**
 * The settings, with the credential provably absent.
 *
 * For anything that leaves this machine — a bug report, a config someone
 * pastes into an issue, a diagnostics dump. The key is removed by
 * destructuring rather than by deleting a field, so a future setting added
 * next to it cannot be forgotten here: the type says what survives.
 */
export function exportVoiceSettings(storage?: Storage): Omit<VoiceSettings, "openRouterApiKey"> {
  const { openRouterApiKey: _omitted, ...rest } = loadVoiceSettings(storage).settings
  return rest
}

export const clearVoiceSettings = resetVoiceSettings
