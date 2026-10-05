/**
 * Microsoft MAI-Voice as a reply voice, through OpenRouter.
 *
 * One sentence in, one WAV out. The endpoint answers with raw PCM and a
 * content type that says what the PCM is; anything else is refused rather than
 * played, because a format nobody checked is a format that comes out as noise.
 * The request is streamed and wrapped only once it is whole: the player takes
 * a WAV, and a WAV cannot be cancelled halfway through a sample.
 *
 * Nothing here talks to the network unless it is handed a `fetchFn`. The tests
 * hand it one that never leaves the process, and the workbench is what hands
 * it the real one — which is why this module does not import one.
 */

import { MAI_MODEL, MAI_VOICES, type MaiVoiceId } from "../settings/reply-voices"

/** What one character is reserved at, in dollars. The list price is $15 per million. */
export const MAI_USD_PER_CHAR = 0.000015

/** PCM the trial measured: 16-bit, mono, 24 kHz. Anything else is refused. */
export const MAI_SAMPLE_RATE = 24_000
export const MAI_CHANNELS = 1
export const MAI_BITS = 16

export const MAI_ENDPOINT = "https://openrouter.ai/api/v1/audio/speech"

/** How long one sentence may take in all, and how long the first byte may take. */
export const MAI_DEADLINE_MS = 15_000
export const MAI_FIRST_BYTE_MS = 5_000

/** How long a 429 stays closed when the response names nothing. */
export const MAI_RETRY_AFTER_MS = 30_000
/** How long a 403 or 404 stays closed: access and the model change out of band. */
export const MAI_MANUAL_COOLDOWN_MS = 60_000

const EXPECTED_TYPE = `audio/pcm;rate=${MAI_SAMPLE_RATE};channels=${MAI_CHANNELS}`

export type MaiFailureKind =
  | "no-key"
  | "aborted"
  | "payment"
  | "unauthorized"
  | "forbidden"
  | "unavailable"
  | "rate-limited"
  | "bad-request"
  | "transient"
  | "format"
  | "empty"
  | "timeout"

export class MaiError extends Error {
  constructor(
    readonly kind: MaiFailureKind,
    /** What the panel may show. Never the response body, never the key. */
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = "MaiError"
  }
}

export interface MaiSpeakRequest {
  voice: MaiVoiceId
  text: string
  signal?: AbortSignal
}

export interface MaiSpeakResult {
  wav: ArrayBuffer
  /** What the reservation was, before any settlement. Dollars. */
  reservedUsd: number
  /** Present when the response named a generation; absent means the reservation stands. */
  generationId?: string
}

export interface MaiClientDeps {
  /** Read at every attempt: a key removed between sentences is a key that is gone. */
  apiKey: () => string | undefined
  fetchFn: (input: string, init: RequestInit) => Promise<Response>
  now?: () => number
  /** Replaces the two deadlines, so a test can expire one without waiting. */
  schedule?: (ms: number) => Promise<never>
}

/** What a sentence costs to reserve, before OpenRouter says what it really cost. */
export function reserveMai(text: string): number {
  return text.length * MAI_USD_PER_CHAR
}

/** A 16-bit PCM buffer wrapped as a WAV the player already knows how to play. */
export function pcmToWav(pcm: Uint8Array, sampleRate = MAI_SAMPLE_RATE, channels = MAI_CHANNELS): ArrayBuffer {
  const dataSize = pcm.byteLength
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const write = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i))
  }
  write(0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  write(8, "WAVE")
  write(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, (sampleRate * channels * MAI_BITS) / 8, true)
  view.setUint16(32, (channels * MAI_BITS) / 8, true)
  view.setUint16(34, MAI_BITS, true)
  write(36, "data")
  view.setUint32(40, dataSize, true)
  new Uint8Array(buffer, 44).set(pcm)
  return buffer
}

/**
 * Whether MAI may be asked right now.
 *
 * Closed after a failure that spending again would not fix, and open again
 * once its cooldown has passed — or, for the ones that do not pass on their
 * own, once `retry` is called. A success opens it immediately: the outage is
 * over because a sentence got through.
 */
export interface MaiBreaker {
  /** `undefined` when a request may go out; otherwise why it may not, and when it may again. */
  blocked(now: number): { kind: MaiFailureKind; until: number } | undefined
  trip(kind: MaiFailureKind, now: number, retryAfterMs?: number): void
  /** A sentence that was actually spoken. */
  reset(): void
  /** The panel's «Riprova». Opens it whatever closed it. */
  retry(): void
}

const COOLDOWN_MS: Partial<Record<MaiFailureKind, number>> = {
  forbidden: MAI_MANUAL_COOLDOWN_MS,
  unavailable: MAI_MANUAL_COOLDOWN_MS,
  "rate-limited": MAI_RETRY_AFTER_MS,
  transient: MAI_RETRY_AFTER_MS,
  timeout: MAI_RETRY_AFTER_MS,
  empty: MAI_RETRY_AFTER_MS,
  format: MAI_RETRY_AFTER_MS,
}

/**
 * Kinds the cooldown does not reopen: only a different key, or «Riprova».
 *
 * A 402 is one of them. Credit comes back when the user adds it, not when a
 * minute has passed, and a breaker that reopened by itself would send a request
 * a minute for as long as the account stays empty. A `Retry-After` on these is
 * not a promise that anything changed, so it is not honoured either.
 */
const MANUAL: ReadonlySet<MaiFailureKind> = new Set(["unauthorized", "bad-request", "payment"])

export function createMaiBreaker(): MaiBreaker {
  let closed: { kind: MaiFailureKind; until: number } | undefined
  return {
    blocked(now) {
      if (!closed) return undefined
      if (!MANUAL.has(closed.kind) && now >= closed.until) {
        closed = undefined
        return undefined
      }
      return closed
    },
    trip(kind, now, retryAfterMs) {
      if (MANUAL.has(kind)) {
        closed = { kind, until: Number.POSITIVE_INFINITY }
        return
      }
      closed = { kind, until: now + (retryAfterMs ?? COOLDOWN_MS[kind] ?? MAI_RETRY_AFTER_MS) }
    },
    reset() {
      closed = undefined
    },
    retry() {
      closed = undefined
    },
  }
}

/** One sentence, as WAV. Throws `MaiError`; never throws anything else. */
export async function speakMai(request: MaiSpeakRequest, deps: MaiClientDeps): Promise<MaiSpeakResult> {
  const key = deps.apiKey()
  if (!key) throw new MaiError("no-key", "Manca la chiave OpenRouter.")
  const voice = MAI_VOICES.find((candidate) => candidate.id === request.voice)
  if (!voice) throw new MaiError("bad-request", "Voce MAI sconosciuta.")
  const text = request.text.trim()
  if (text.length === 0) throw new MaiError("bad-request", "Niente da leggere.")

  const outer = request.signal
  if (outer?.aborted) throw new MaiError("aborted", "Lettura annullata.")
  const controller = new AbortController()
  const onOuter = () => controller.abort()
  outer?.addEventListener("abort", onOuter)

  const now = deps.now ?? Date.now
  const startedAt = now()
  // The deadlines are cleared on the way out: a sentence read in a second leaves no timer behind for fifteen.
  const timers: ReturnType<typeof setTimeout>[] = []
  const schedule =
    deps.schedule ??
    ((ms: number) =>
      new Promise<never>((_, reject) => {
        timers.push(setTimeout(() => reject(new MaiError("timeout", "MAI non ha risposto in tempo.")), ms))
      }))
  // Until the PCM is whole, the request is open; leaving any other way closes it, so nothing goes on being paid for.
  let whole = false

  try {
    const pending = deps.fetchFn(MAI_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MAI_MODEL,
        input: text,
        voice: voice.wire,
        response_format: "pcm",
      }),
      signal: controller.signal,
    })
    const response = await Promise.race([pending, schedule(MAI_FIRST_BYTE_MS)])
    if (!response.ok) throw await failureOf(response)
    const type = (response.headers.get("content-type") ?? "").toLowerCase().replace(/\s/g, "")
    if (type !== EXPECTED_TYPE) {
      throw new MaiError("format", `MAI ha risposto ${type || "senza tipo"}, atteso ${EXPECTED_TYPE}.`)
    }
    const pcm = await readBody(response, controller, schedule, MAI_DEADLINE_MS - (now() - startedAt))
    if (pcm.byteLength === 0) throw new MaiError("empty", "MAI ha risposto senza audio.")
    if (pcm.byteLength % 2 !== 0) throw new MaiError("format", "Audio MAI di lunghezza dispari.")
    whole = true
    return {
      wav: pcmToWav(pcm),
      reservedUsd: reserveMai(text),
      generationId: response.headers.get("x-generation-id") ?? undefined,
    }
  } catch (error) {
    if (error instanceof MaiError) throw error
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new MaiError("aborted", "Lettura annullata.")
    }
    throw new MaiError("transient", "MAI non raggiungibile.")
  } finally {
    if (!whole) controller.abort()
    for (const timer of timers) clearTimeout(timer)
    outer?.removeEventListener("abort", onOuter)
  }
}

async function readBody(
  response: Response,
  controller: AbortController,
  schedule: (ms: number) => Promise<never>,
  remainingMs: number,
): Promise<Uint8Array> {
  const body = response.body
  if (!body) {
    const whole = new Uint8Array(await response.arrayBuffer())
    return whole
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  const read = async (): Promise<Uint8Array> => {
    let total = 0
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(next.value)
      total += next.value.byteLength
    }
    const pcm = new Uint8Array(total)
    let at = 0
    for (const chunk of chunks) {
      pcm.set(chunk, at)
      at += chunk.byteLength
    }
    return pcm
  }
  try {
    return await Promise.race([read(), schedule(Math.max(0, remainingMs))])
  } catch (error) {
    controller.abort()
    throw error
  }
}

async function failureOf(response: Response): Promise<MaiError> {
  const retryAfter = retryAfterMs(response.headers.get("retry-after"))
  const status = response.status
  if (status === 401) return new MaiError("unauthorized", "Chiave OpenRouter rifiutata.")
  if (status === 402) return new MaiError("payment", "Credito OpenRouter esaurito.")
  if (status === 403) return new MaiError("forbidden", "OpenRouter ha rifiutato la richiesta.", retryAfter)
  if (status === 404) return new MaiError("unavailable", "MAI non è disponibile.", retryAfter)
  if (status === 429) return new MaiError("rate-limited", "Troppe richieste a MAI.", retryAfter)
  if (status === 400 || status === 413) return new MaiError("bad-request", "Richiesta MAI rifiutata.")
  return new MaiError("transient", `MAI ha risposto ${status}.`, retryAfter)
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(header)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - Date.now())
}
