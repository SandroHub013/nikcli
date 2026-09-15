import { Data } from "effect"

/**
 * Typed domain errors for the voice subsystem.
 *
 * Each error represents a specific failure mode distinguishable at runtime.
 * User-facing Italian speech readbacks are strictly separated from error
 * definitions and provided centrally by `spokenMessage()`.
 */

export class MicPermissionDenied extends Data.TaggedError("MicPermissionDenied")<{
  readonly message?: string
  readonly cause?: unknown
}> {}

export class MicUnavailable extends Data.TaggedError("MicUnavailable")<{
  readonly message?: string
  readonly cause?: unknown
}> {}

export class AudioFormatUnsupported extends Data.TaggedError("AudioFormatUnsupported")<{
  readonly attemptedFormats: readonly string[]
  readonly message?: string
}> {}

export class SpeechRecognitionUnavailable extends Data.TaggedError("SpeechRecognitionUnavailable")<{
  readonly message?: string
}> {}

export class ModelLoadFailed extends Data.TaggedError("ModelLoadFailed")<{
  readonly backend: string
  readonly cause?: unknown
  readonly message?: string
}> {}

export class TranscriptionFailed extends Data.TaggedError("TranscriptionFailed")<{
  readonly cause: unknown
  readonly message?: string
}> {}

export class ApiKeyMissing extends Data.TaggedError("ApiKeyMissing")<{
  readonly message?: string
}> {}

export class ApiKeyInvalid extends Data.TaggedError("ApiKeyInvalid")<{
  readonly message?: string
  readonly cause?: unknown
}> {}

export class QuotaExhausted extends Data.TaggedError("QuotaExhausted")<{
  readonly message?: string
  readonly cause?: unknown
}> {}

export class RequestTimeout extends Data.TaggedError("RequestTimeout")<{
  readonly timeoutMs?: number
  readonly message?: string
}> {}

export class HostActionFailed extends Data.TaggedError("HostActionFailed")<{
  readonly action: string
  readonly cause?: unknown
  readonly message?: string
}> {}

export type VoiceError =
  | MicPermissionDenied
  | MicUnavailable
  | AudioFormatUnsupported
  | SpeechRecognitionUnavailable
  | ModelLoadFailed
  | TranscriptionFailed
  | ApiKeyMissing
  | ApiKeyInvalid
  | QuotaExhausted
  | RequestTimeout
  | HostActionFailed

const KNOWN_TAGS: ReadonlySet<string> = new Set([
  "MicPermissionDenied",
  "MicUnavailable",
  "AudioFormatUnsupported",
  "SpeechRecognitionUnavailable",
  "ModelLoadFailed",
  "TranscriptionFailed",
  "ApiKeyMissing",
  "ApiKeyInvalid",
  "QuotaExhausted",
  "RequestTimeout",
  "HostActionFailed",
])

/**
 * Digs the typed error out of whatever is wrapped around it.
 *
 * Errors cross the Effect boundary before they reach a caller that awaits a
 * promise, and what arrives is a FiberFailure holding the real failure rather
 * than the failure itself. Reading only the outermost object therefore found no
 * tag on anything, and every cause the user could actually do something about —
 * a missing API key, a denied microphone, a model that would not load — was
 * reported as "si è verificato un errore durante l'operazione vocale".
 */
function findTagged(error: unknown, depth = 0): { _tag: string } | undefined {
  if (!error || typeof error !== "object" || depth > 6) return undefined

  const candidate = error as Record<string, unknown>
  if (typeof candidate._tag === "string" && KNOWN_TAGS.has(candidate._tag)) {
    return candidate as { _tag: string }
  }

  // `cause` and `error` cover Error chaining, Effect's Cause tree and its
  // Fail/Die nodes; the symbol is how a FiberFailure carries its own cause.
  for (const key of ["cause", "error", "failure", "left", "right"]) {
    const found = findTagged(candidate[key], depth + 1)
    if (found) return found
  }

  for (const symbol of Object.getOwnPropertySymbols(candidate)) {
    const found = findTagged(
      (candidate as unknown as Record<symbol, unknown>)[symbol],
      depth + 1
    )
    if (found) return found
  }

  return undefined
}

/**
 * What went wrong, coarsely — for the UI, which needs to colour a thing.
 *
 * `spokenMessage` answers "what do I tell the user"; this answers "which of
 * the three lights is this". They are deliberately separate: the sentence can
 * be rewritten without changing what the widget's rim does, and the widget
 * never has to match Italian prose to decide on a colour — which is what it
 * would otherwise have had to do, `lastError()` being a string by the time it
 * reaches anyone.
 *
 * `mic-auth` is its own kind rather than an error because it is the one
 * failure the user can fix in five seconds, from a browser prompt they have
 * probably already dismissed once. Everything a person cannot act on is
 * `failed` and gets one colour.
 */
export type VoiceErrorKind = "mic-auth" | "failed"

export function errorKind(error: unknown): VoiceErrorKind {
  if (typeof error === "string") {
    const lower = error.toLowerCase()
    if (
      lower.includes("negato") ||
      lower.includes("notallowed") ||
      lower.includes("permission") ||
      lower.includes("nessun microfono") ||
      lower.includes("notfound")
    ) {
      return "mic-auth"
    }
    return "failed"
  }

  const tagged = findTagged(error)
  /*
   * "No microphone detected" sits here with "permission denied" on purpose:
   * from the widget's side both are "the hardware is not yours yet, and the
   * fix is outside this window" — the difference between them is a sentence,
   * and the sentence is already being shown.
   */
  if (tagged?._tag === "MicPermissionDenied" || tagged?._tag === "MicUnavailable") {
    return "mic-auth"
  }

  if (error instanceof Error && error.message) {
    const lower = error.message.toLowerCase()
    if (
      lower.includes("negato") ||
      lower.includes("notallowed") ||
      lower.includes("permission") ||
      lower.includes("nessun microfono") ||
      lower.includes("notfound")
    ) {
      return "mic-auth"
    }
  }

  return "failed"
}

/**
 * Translates a typed voice error into an Italian phrase suitable for text-to-speech output.
 * Guarantees that sensitive secrets (e.g. API keys) are never spoken or returned.
 */
export function spokenMessage(error: unknown): string {
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim()
  }

  const tagged = findTagged(error)
  if (tagged) {
    const tag = tagged._tag
    switch (tag) {
      /* The sentence says where the fix is, because for these two there is
         one and it is not in this window. */
      case "MicPermissionDenied":
        return "Accesso al microfono negato: consentilo nelle impostazioni di privacy del sistema (Windows: Impostazioni › Privacy e sicurezza › Microfono, per le app desktop)."
      case "MicUnavailable":
        return "Nessun microfono rilevato o non accessibile. Collega un dispositivo audio e riprova."
      case "AudioFormatUnsupported":
        return "Nessun formato audio supportato per la registrazione."
      case "SpeechRecognitionUnavailable":
        return "Riconoscimento vocale non supportato da questo browser."
      case "ModelLoadFailed":
        return "Impossibile caricare il modello di riconoscimento vocale locale."
      case "TranscriptionFailed":
        return "Errore durante la trascrizione dell'audio."
      case "ApiKeyMissing":
        return "Chiave API OpenRouter mancante. Specificare una chiave valida."
      case "ApiKeyInvalid":
        return "Autenticazione OpenRouter fallita: chiave API non valida o revocata."
      case "QuotaExhausted":
        return "Credito OpenRouter esaurito: ricarica il conto sul tuo account."
      case "RequestTimeout":
        return "Richiesta di trascrizione scaduta per timeout."
      case "HostActionFailed":
        return "Errore durante l'esecuzione dell'azione sull'ambiente ADE."
    }
  }

  if (error instanceof Error && error.message) {
    const msg = error.message.trim()
    const lower = msg.toLowerCase()
    if (
      lower.includes("chiave api") ||
      lower.includes("openrouter") ||
      lower.includes("microfono") ||
      lower.includes("permesso") ||
      lower.includes("permission") ||
      lower.includes("notallowed") ||
      lower.includes("timeout") ||
      lower.includes("credito")
    ) {
      return msg
    }
    return "Si è verificato un errore durante l'operazione vocale."
  }

  return "Si è verificato un errore imprevisto durante l'ascolto vocale."
}
