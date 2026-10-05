/**
 * Transcriber backend selection and readiness diagnostics.
 *
 * One engine, which works inside an embedded webview:
 * - "openrouter": Cloud ASR via OpenRouter (microsoft/mai-transcribe-2)
 * - "grok-stream": Cloud ASR over the streaming socket to xAI, with the
 *   OpenRouter request behind it for every segment the socket does not carry
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
import {
  createOpenRouterTranscriber,
  normalizeRequestLanguage,
  transcribeSegment,
  type OpenRouterTranscriberOptions,
} from "./openrouter"
import {
  createGrokStreamTranscriber,
  type GrokBatch,
  type StreamSpend,
  type StreamState,
  type SttStreamTransport,
} from "./grok-stream"
import { t } from "@nikcli-ai/ade/i18n"

// ---------------------------------------------------------------------------
// Backend Identifier & Status Types
// ---------------------------------------------------------------------------

export type TranscriberBackend = "openrouter" | "grok-stream"

export interface BackendStatus {
  /** Whether the backend can be activated and used right now. */
  usable: boolean
  /** Localized Italian explanation if not currently usable. */
  reason?: string
}

export interface BackendDescriptions {
  openrouter: BackendStatus
  grokStream: BackendStatus
}

/** What the streaming backend needs from whoever chose it. */
export interface GrokStreamSelectOptions {
  /** The socket to the streaming service; ADE builds it over `stt_stream_*`. */
  transport: SttStreamTransport
  /** Wake word and custom words, sent so they come back as written. */
  keyterms?: readonly string[]
  /** Where the streamed seconds are counted: the day's tally, read before every socket opens. */
  spend?: StreamSpend
  /** Dollars of streaming allowed per day (`VoiceSettings.streamDailyCapUsd`); 0 is off. A getter is read per socket. */
  dailyCapUsd?: number | (() => number)
  /** Told when the reason the stream is or is not carrying sentences changes: the settings page shows it. */
  onStreamState?: (state: StreamState) => void
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
  /** Options passed when constructing the Grok streaming transcriber. */
  grokStreamOptions?: GrokStreamSelectOptions
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
    // OpenRouter Cloud — and the streaming backend, whose refusals all fall
    // back to this same account: without the key neither can carry a sentence.
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
      grokStream: { ...openrouterStatus },
    }
  } catch {
    return {
      openrouter: {
        usable: false,
        reason: t("vui.asr.keyCheck"),
      },
      grokStream: {
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

    case "grok-stream": {
      const or = options.openRouterOptions
      const apiKey = options.apiKey ?? or?.apiKey ?? ""
      const transport = options.grokStreamOptions?.transport
      if (!transport) {
        throw new Error("Streaming Grok senza transport: la sessione stt_stream non è stata iniettata.")
      }
      /*
       * The fallback is the very same request the OpenRouter backend sends,
       * bound here to this backend's options: one request builder, two
       * backends, and the refusals of the socket land on the account that
       * would have carried them anyway.
       */
      const batch: GrokBatch = (request) => {
        const raw = or?.language ?? options.language
        return transcribeSegment(request.segment, request.deliver, request.purpose, request.gated, {
          apiKey,
          languageSetting: raw,
          language: normalizeRequestLanguage(raw),
          model: or?.model,
          timeoutMs: or?.timeoutMs,
          fetch: or?.fetch,
          // The purpose is bound to the request by the caller that built it.
          onError: (error) => request.report(error),
          onUsage: or?.onUsage,
        })
      }
      return createGrokStreamTranscriber({
        transport,
        batch,
        language: or?.language ?? options.language,
        keyterms: options.grokStreamOptions?.keyterms,
        spend: options.grokStreamOptions?.spend,
        dailyCapUsd: options.grokStreamOptions?.dailyCapUsd,
        onStreamState: options.grokStreamOptions?.onStreamState,
        now: or?.now,
        nameGate: or?.nameGate,
        capture: or?.capture,
        captureOptions: or?.captureOptions,
        onPartial: or?.onPartial,
        onFinal: or?.onFinal,
        onError: or?.onError,
      })
    }

    default:
      throw new Error(`Backend di trascrizione non riconosciuto: ${backend}`)
  }
}
