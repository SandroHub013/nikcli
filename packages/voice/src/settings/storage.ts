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
 * The OpenRouter key, kept out of the settings blob.
 *
 * It used to be one field among the rest, so anything that touched the
 * settings touched the credential: a copied `voice.settings` for a bug
 * report, a settings dump in a log, a future export feature — each would
 * have carried a live API key without anyone deciding that it should.
 *
 * This does not make it secret. It is still plaintext in the WebView2
 * profile on disk, which is what browser storage is; the fix for *that* is
 * the OS credential store behind a Tauri command, and it is not this. What
 * the split buys is that the key is now reached deliberately, by name, and
 * `exportVoiceSettings` below can hand out settings that provably exclude it.
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
     * The key comes from its own slot, and from the blob only once.
     *
     * A profile written before the split still has it inside `voice.settings`;
     * reading it from there keeps that user signed in, and the first save
     * moves it out and strips it from the blob for good.
     */
    const stored = safeRead(store, VOICE_API_KEY_STORAGE_KEY)
    const legacy =
      typeof parsed === "object" && parsed !== null && "openRouterApiKey" in parsed
        ? (parsed as { openRouterApiKey?: unknown }).openRouterApiKey
        : undefined

    const apiKey = stored || (typeof legacy === "string" ? legacy : "")
    const merged =
      parsed === null && !apiKey
        ? null
        : { ...(typeof parsed === "object" && parsed !== null ? parsed : {}), openRouterApiKey: apiKey }

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

/** Writes the blob and the credential, each in its own slot. Never throws. */
function writeSettings(store: Storage, settings: VoiceSettings): boolean {
  try {
    // The blob never carries the credential again, including for a profile
    // that had it inline before the split.
    const { openRouterApiKey, ...withoutKey } = settings
    store.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify(withoutKey))
    if (openRouterApiKey) {
      store.setItem(VOICE_API_KEY_STORAGE_KEY, openRouterApiKey)
    } else {
      store.removeItem(VOICE_API_KEY_STORAGE_KEY)
    }
    return true
  } catch {
    return false
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
    if (normalized.settings.openRouterApiKey) clearOpenRouterKeyRemoved(store)
    else if (current.settings.openRouterApiKey) markOpenRouterKeyRemoved(store)
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
    const hadKey = Boolean(loadVoiceSettings(store, options).openRouterApiKey)
    try {
      store.removeItem(VOICE_SETTINGS_STORAGE_KEY)
      // The credential goes too. "Reset" that leaves an API key behind is
      // the one reading of the word nobody has.
      store.removeItem(VOICE_API_KEY_STORAGE_KEY)
      if (hadKey) markOpenRouterKeyRemoved(store)
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
