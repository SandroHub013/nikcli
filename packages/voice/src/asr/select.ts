/**
 * Transcriber backend selection and readiness diagnostics.
 *
 * One engine, which works inside an embedded webview:
 * - "openrouter": Cloud ASR via OpenRouter (microsoft/mai-transcribe-2)
 *
 * There were two more, and both are gone. A local neural model (NVIDIA Parakeet TDT 0.6B v3, on
 * WebGPU/WASM) took the renderer past four gigabytes and stopped it answering, and it carried a 24 MB
 * WebAssembly runtime into every installer. And the browser's own Web Speech API: Inside
 * Tauri's WebView2 the constructor exists and the service behind it does not:
 * every `start()` was answered by an immediate `end` with no audio event, no
 * result and no error, so the app reported "listening" to a user talking to
 * nothing. ADE only ever runs in a webview, so an engine that only works in a
 * plain browser tab was a default that could never work where it shipped.
 *
 * Provides describeBackends() to inform the ADE UI why any engine is or isn't usable right now.
 */

import type { Transcriber } from "./transcriber"
import { createOpenRouterTranscriber, type OpenRouterTranscriberOptions } from "./openrouter"
import { t } from "@nikcli-ai/ade/i18n"

// ---------------------------------------------------------------------------
// Backend Identifier & Status Types
// ---------------------------------------------------------------------------

export type TranscriberBackend = "openrouter"

export interface BackendStatus {
  /** Whether the backend can be activated and used right now. */
  usable: boolean
  /** Localized Italian explanation if not currently usable. */
  reason?: string
}

export interface BackendDescriptions {
  openrouter: BackendStatus
}

export interface SelectTranscriberOptions {
  /** OpenRouter API key. */
  apiKey?: string
  /**
   * `VoiceSettings.language`, applied to whichever backend is chosen.
   *
   * Set here rather than twice in the per-backend options because it is one
   * user decision, and the two places it used to be spelled were both the
   * constant `"it"`. A backend-specific option still wins, for a caller that
   * has a reason to differ.
   */
  language?: string
  /** Options passed when constructing the OpenRouter transcriber. */
  openRouterOptions?: Partial<OpenRouterTranscriberOptions>
}

// ---------------------------------------------------------------------------
// Backend Readiness Inspection
// ---------------------------------------------------------------------------

/**
 * Diagnostics utility returning usability state and user-facing Italian reasons
 * for the transcription backends.
 *
 * Guarantees: Never throws.
 */
export function describeBackends(options: SelectTranscriberOptions = {}): BackendDescriptions {
  try {
    // OpenRouter Cloud
    const candidateKey = options.apiKey ?? options.openRouterOptions?.apiKey
    const hasValidKey = Boolean(candidateKey && candidateKey.trim().length > 0)
    const openrouterStatus: BackendStatus = hasValidKey
      ? { usable: true }
      : {
          usable: false,
          reason: t("vui.asr.noKey"),
        }

    return {
      openrouter: openrouterStatus,
    }
  } catch {
    return {
      openrouter: {
        usable: false,
        reason: t("vui.asr.keyCheck"),
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Backend Transcriber Factory
// ---------------------------------------------------------------------------

/**
 * Creates a Transcriber instance for the requested backend.
 */
export function createTranscriberFor(backend: TranscriberBackend, options: SelectTranscriberOptions = {}): Transcriber {
  switch (backend) {
    case "openrouter": {
      const apiKey = options.apiKey ?? options.openRouterOptions?.apiKey ?? ""
      return createOpenRouterTranscriber({
        language: options.language,
        ...options.openRouterOptions,
        apiKey,
      })
    }

    default:
      throw new Error(`Backend di trascrizione non riconosciuto: ${backend}`)
  }
}
