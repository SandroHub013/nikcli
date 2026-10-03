/**
 * Streaming speech-to-text over the Grok 4.7 Fast endpoint, through the local
 * Tauri runtime that holds the key.
 *
 * While a sentence is being spoken, its PCM goes out in 100 ms pieces and the
 * answer comes back as partials; when the sentence closes, `audio.done` is
 * sent and the composed text becomes the final. The WAV the capture closed is
 * held back and sent to the batch endpoint (microsoft/mai-transcribe-2) only
 * when the stream cannot produce the text: a refusal, a pause, the daily cap,
 * a sentence that never came back, or a segment the gate kept out of the
 * socket.
 *
 * The socket itself lives on the other side of the Tauri boundary and is
 * injected as a `SttStreamTransport`; the batch request is the very same one
 * the OpenRouter backend sends, injected as a `GrokBatch`. Nothing in here
 * knows a URL or a key.
 */

import { markVoice } from "../timing"
import { plainProblem } from "../effect/errors"
import type {
  FinalTranscriptCallback,
  PartialTranscriptCallback,
  Transcriber,
  TranscriberErrorCallback,
  TranscriberErrorPurpose,
  TranscriberOptions,
} from "./transcriber"
import {
  createMicCapture,
  type CapturedSegment,
  type MicCapture,
  type MicCaptureOptions,
  type SegmentAudio,
} from "../audio/capture"
import { MicPermissionDenied, MicUnavailable, TranscriptionFailed } from "../effect/errors"
import {
  NAME_PROBE_MS,
  NAME_PROBE_WHOLE_UNDER_MS,
  normalizeRequestLanguage,
  sanitizeApiKey,
  wavHead,
  type NameGate,
} from "./openrouter"

// ---------------------------------------------------------------------------
// Transport contract
// ---------------------------------------------------------------------------

/** Why the stream ended without a transcript; the codes the local runtime reports. */
export type SttStreamReason =
  | "noKey"
  | "auth"
  | "credit"
  | "rate"
  | "unavailable"
  | "network"
  | "timeout"
  | "protocol"
  | "backpressure"

/** What the local runtime reports while a segment streams. */
export type SttStreamEvent =
  | { kind: "ready" }
  | { kind: "partial"; text: string; isFinal: boolean; speechFinal: boolean }
  | { kind: "done"; text: string; durationS?: number }
  | { kind: "failed"; reason: SttStreamReason; status?: number }

export interface SttStreamOpenOptions {
  /** ISO-639-1 code to recognize, absent for detection. */
  language?: string
  /** Words the service must hear as written: wake word and custom words. */
  keyterms: readonly string[]
  /** Where this segment's events arrive, for as long as it lives. */
  onEvent: (event: SttStreamEvent) => void
}

/**
 * The socket to the streaming service, one segment at a time.
 *
 * Implemented in ADE over `stt_stream_open`/`_send`/`_end`/`_cancel`, and in
 * tests over an object literal. `open` resolves once the session exists;
 * everything queued before it - frames, the end - goes out in order after it.
 *
 * One session at a time, and this is why: `send` and `cancel` name no
 * session, so two sockets alive at once could not be told apart — a frame or
 * a cancellation would reach the wrong one. The factory keeps a chain that
 * opens the next socket only after the previous session has closed, so
 * whatever this transport is asked to do belongs to the single session it
 * holds.
 */
export interface SttStreamTransport {
  /** Opens the session for the segment that just started. */
  open(options: SttStreamOpenOptions): Promise<void>
  /** One piece of 16 kHz mono PCM16LE audio, about 100 ms. */
  send(bytes: Uint8Array): Promise<void>
  /** The segment is over: `audio.done` goes out and `done` follows. */
  end(): Promise<void>
  /** The segment is dropped now; no further event arrives for it. */
  cancel(): void
}

// ---------------------------------------------------------------------------
// The batch request (the fallback path)
// ---------------------------------------------------------------------------

/** One request to the batch endpoint, with its outcome already routed. */
export interface GrokBatchRequest {
  segment: CapturedSegment
  deliver: (text: string) => void
  purpose: TranscriberErrorPurpose
  /** The request was one made while waiting for the name, not a turn. */
  gated: boolean
  /** Errors of this request go here, bound to its purpose. */
  report: (error: Error) => void
}

/**
 * The fallback: the same request the OpenRouter backend sends, bound to its
 * account by whoever chose this backend.
 */
export type GrokBatch = (request: GrokBatchRequest) => Promise<void>

// ---------------------------------------------------------------------------
// Counting and limits
// ---------------------------------------------------------------------------

/** 100 ms of 16 kHz mono audio: the piece the stream carries. */
export const STREAM_FRAME_SAMPLES = 1_600

/** Bytes a second of that audio costs: 16 kHz × 2 bytes. */
export const STREAM_BYTES_PER_SECOND = 32_000

/** Dollars of streaming allowed per day. */
export const STREAM_DAILY_CAP_USD = 0.5

/** What a streamed hour counts against the cap, until settings carry their own rate. */
export const STREAM_USD_PER_HOUR = 0.2

/** Where streamed audio is counted, so the cap can stop it in time. */
export interface StreamSpend {
  /** Dollars of streaming audio counted so far today. */
  costToday(): number
  /** Count seconds of audio the stream actually carried. */
  addSeconds(seconds: number): void
}

export interface GrokStreamTranscriberOptions extends TranscriberOptions {
  /** The socket to the streaming service; required — this backend is it. */
  transport: SttStreamTransport
  /** The batch endpoint, for every segment the socket does not carry. */
  batch: GrokBatch
  /** Pre-existing microphone pipeline; one is created when it is not given. */
  capture?: MicCapture
  /** Options for the pipeline created here. */
  captureOptions?: MicCaptureOptions
  /** Keeps the room out of the socket while nobody has called the assistant; see `NameGate`. */
  nameGate?: NameGate
  /** ISO-639-1 code from the settings: `"auto"` asks the service to detect. */
  language?: string
  /** Wake word and custom words, sent so they come back as written. */
  keyterms?: readonly string[]
  /** Where streamed seconds are counted; a local counter is used when absent. */
  spend?: StreamSpend
  /** Dollars of streaming allowed per day (default 0.50). */
  dailyCapUsd?: number
  /** Dollars a streamed hour counts for, with the local counter (default 0.20). */
  usdPerHour?: number
  /** Silence after a rate or unavailability refusal (default 60 s). */
  pauseRateMs?: number
  /** Silence after a network or timeout failure (default 30 s). */
  pauseNetworkMs?: number
  /** How long after `audio.done` to wait for `transcript.done` before batching (default 5 s). */
  doneTimeoutMs?: number
  /** Dependency injection hook for time (epoch ms). */
  now?: () => number
}

export interface GrokStreamTranscriber extends Transcriber {
  /** Underlying microphone capture adapter. */
  readonly capture: MicCapture
  /** Whether the stream or the fallback still owes a sentence. */
  readonly hasInFlight: boolean
  startSegment(): void
  commit(): boolean
  cancelSegment(): void
  finish(): void
  /**
   * Forgets the refusals and the pauses: what «Riprova» does.
   *
   * The auth latch, the credit pause and the rate pauses all clear here; the
   * day's counting does not, because the day is what it is counting.
   */
  retryStreaming(): void
}

// ---------------------------------------------------------------------------
// Flow state
// ---------------------------------------------------------------------------

interface Flow {
  sequence: number
  /** When the sentence began, for the final that carries it. */
  spokenAt: number
  /** The segment was begun while the gate was waiting for the name. */
  gated: boolean
  /** The socket may open for this one: not gated, not latched, under the cap. */
  streamable: boolean
  /** `transport.open` has been called for this one: the session is its own. */
  opened: boolean
  /** The open settled — resolved, rejected, or skipped after an abandonment. */
  openSettled: boolean
  /** Its socket is gone: done, failed, cancelled, or never opened at all. */
  socketGone: boolean
  /** The one-session chain has been let through for this flow. */
  released: boolean
  /** Hands the one-session chain to the next flow; streamable flows only. */
  release?: () => void
  /** `audio.done` has been sent; the answer is on its way. */
  ended: boolean
  /** The stream gave up (or never was): the batch path owns this sentence. */
  fallback: boolean
  /** The sentence has been produced, dropped, or cancelled. */
  settled: boolean
  /** The batch request is running. */
  batching: boolean
  /** The closed segment, held as the fallback's ammunition. */
  wav?: CapturedSegment
  /** Resolves when the session exists; frames and the end queue behind it. */
  openPromise?: Promise<void>
  doneTimer?: ReturnType<typeof setTimeout>
  /** Speech the service called complete, in order. */
  speechFinals: string[]
  /** Stable pieces after the last complete speech. */
  finalPieces: string[]
  /** The last hypothesis, provisional or not. */
  provisional: string
  /** What `transcript.done` carried, when it arrived. */
  doneText: string
  /** PCM not yet a whole 100 ms piece. */
  pending: Float32Array[]
  pendingSamples: number
}

/** One frame of PCM16LE, little-endian, clipped like the WAV encoder. */
function pcm16le(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return bytes
}

/** The refusal codes as the local runtime reports them, in its own words. */
function reasonOf(message: string): SttStreamReason {
  const m = String(message).toLowerCase()
  if (m.includes("no-key") || m.includes("no key") || m.includes("chiave")) return "noKey"
  if (m.includes("auth")) return "auth"
  if (m.includes("credit") || m.includes("402")) return "credit"
  if (m.includes("backpressure")) return "backpressure"
  if (m.includes("rate") || m.includes("429")) return "rate"
  if (m.includes("unavailable") || m.includes("503")) return "unavailable"
  if (m.includes("timeout")) return "timeout"
  if (m.includes("protocol")) return "protocol"
  return "network"
}

// ---------------------------------------------------------------------------
// GrokStream Transcriber Factory
// ---------------------------------------------------------------------------

export function createGrokStreamTranscriber(options: GrokStreamTranscriberOptions): GrokStreamTranscriber {
  const transport = options.transport
  const batch = options.batch
  const now = options.now ?? Date.now
  const language = normalizeRequestLanguage(options.language)
  const keyterms: readonly string[] = options.keyterms ?? []
  const pauseRateMs = options.pauseRateMs ?? 60_000
  const pauseNetworkMs = options.pauseNetworkMs ?? 30_000
  const doneTimeoutMs = options.doneTimeoutMs ?? 5_000
  const dailyCapUsd = options.dailyCapUsd ?? STREAM_DAILY_CAP_USD

  let partialCb: PartialTranscriptCallback = options.onPartial ?? (() => {})
  let finalCb: FinalTranscriptCallback = options.onFinal ?? (() => {})
  let errorCb: TranscriberErrorCallback = options.onError ?? (() => {})
  let userStopped = true

  /*
   * Until the settings carry the day's stream tally, the counting lives here:
   * seconds in, dollars out at the configured rate. No day can roll over in
   * it, which is why the warning it raises is once per session rather than
   * once per day — the real tally arrives with the settings.
   */
  const usdPerHour = options.usdPerHour ?? STREAM_USD_PER_HOUR
  let localSeconds = 0
  const spend: StreamSpend = options.spend ?? {
    costToday: () => (localSeconds * usdPerHour) / 3600,
    addSeconds: (seconds: number) => {
      localSeconds += Math.max(0, seconds)
    },
  }

  /* What closes the socket for the rest of the session, and for how long. */
  let authLatched = false
  let authWarned = false
  let creditWarned = false
  let creditUntil = 0
  let retryAt = 0
  let capWarned = false

  const flows = new Map<number, Flow>()

  /*
   * The one-session chain: the next flow's socket opens only after the
   * previous session has closed. `send` and `cancel` name no session, so two
   * sockets alive at once could not be told apart — see `SttStreamTransport`.
   */
  let sessionTail: Promise<void> = Promise.resolve()

  /**
   * Hands the chain on when both ends of this flow's session are accounted
   * for: the open settled (so no ghost of it is still being established) and
   * the socket is gone (so no frame of it is still welcome).
   */
  function maybeRelease(flow: Flow): void {
    if (flow.released || !flow.openSettled || !flow.socketGone) return
    flow.released = true
    flow.release?.()
  }

  /** The session of this flow is over; the next one may open. */
  function noteSocketGone(flow: Flow): void {
    flow.socketGone = true
    maybeRelease(flow)
  }

  const micCapture: MicCapture =
    options.capture ?? createMicCapture({ preferredFormat: "wav", ...options.captureOptions })

  // -- Sentence composition ---------------------------------------------------

  /**
   * What this sentence finally said.
   *
   * The service's own `done` text is what it settled on and wins; the pieces
   * spoken complete, with the stable ones after them, stand when it came back
   * empty; the last hypothesis is what is left when neither carried anything.
   */
  function composed(flow: Flow): string {
    const done = flow.doneText.trim()
    if (done) return done
    const joined = [...flow.speechFinals, ...flow.finalPieces].join(" ").trim()
    if (joined) return joined
    return flow.provisional.trim()
  }

  // -- Flow bookkeeping -------------------------------------------------------

  function settle(flow: Flow): void {
    if (flow.settled) return
    flow.settled = true
    if (flow.doneTimer) clearTimeout(flow.doneTimer)
    noteSocketGone(flow)
    flows.delete(flow.sequence)
  }

  /** Whether a segment begun now may open a socket at all. */
  function streamAllowed(): boolean {
    const nowMs = now()
    if (authLatched) return false
    if (nowMs >= creditUntil) creditWarned = false
    if (nowMs < creditUntil) return false
    if (nowMs < retryAt) return false
    if (spend.costToday() >= dailyCapUsd) {
      if (!capWarned) {
        capWarned = true
        errorCb(
          new Error(
            "Oggi ho già mandato l'audio in streaming fino al limite: le frasi successive vanno a MAI-Transcribe-2.",
          ),
          { purpose: "turn" },
        )
      }
      return false
    }
    capWarned = false
    return true
  }

  /** What a refusal means for the sentences after this one. */
  function applyFailure(reason: SttStreamReason): void {
    const nowMs = now()
    switch (reason) {
      case "noKey":
        // No key on the machine: this sentence, and the next attempt, are the
        // batch's business. Nothing is latched — the key can appear at once.
        break
      case "auth":
        authLatched = true
        if (!authWarned) {
          authWarned = true
          errorCb(new Error("La chiave xAI non funziona: trascrivo con MAI-Transcribe-2."), { purpose: "turn" })
        }
        break
      case "credit":
        creditUntil = nowMs + 24 * 3_600_000
        if (!creditWarned) {
          creditWarned = true
          errorCb(new Error("Il credito xAI è finito: trascrivo con MAI-Transcribe-2 finché non lo ricarichi."), {
            purpose: "turn",
          })
        }
        break
      case "rate":
      case "unavailable":
      case "backpressure":
        retryAt = Math.max(retryAt, nowMs + pauseRateMs)
        break
      case "network":
      case "timeout":
        retryAt = Math.max(retryAt, nowMs + pauseNetworkMs)
        break
      case "protocol":
        // Mid-sentence, on this one segment only: the batch takes it over and
        // the socket stays open for the next one.
        break
    }
  }

  /**
   * The stream gives this sentence up: the socket goes, the pauses are set,
   * and the batch picks the sentence up as soon as the capture closes it —
   * or right now, if it closed long ago.
   */
  function failFlow(flow: Flow, reason: SttStreamReason): void {
    if (flow.settled || flow.fallback) return
    markVoice("stt-fallback", reason)
    applyFailure(reason)
    flow.fallback = true
    if (flow.doneTimer) clearTimeout(flow.doneTimer)
    // Only a flow whose open actually ran owns the session to cancel; one
    // still waiting its turn behind the previous socket has nothing to drop.
    if (flow.opened) transport.cancel()
    noteSocketGone(flow)
    if (flow.ended) {
      if (flow.wav) void runBatch(flow, flow.wav)
      else settle(flow)
    }
    // Not ended: the capture still holds the sentence, and its close brings
    // the WAV that `runBatch` is waiting for.
  }

  // -- The socket -------------------------------------------------------------

  function send(flow: Flow, bytes: Uint8Array): void {
    const open = flow.openPromise
    if (!open) {
      failFlow(flow, "protocol")
      return
    }
    void open
      .then(() => {
        // Abandoned while its turn in the chain was still coming up: the
        // frames belong to no session, and the next one must not hear them.
        if (flow.settled || flow.fallback) return false
        return transport.send(bytes).then(() => true)
      })
      .then((sent) => {
        if (sent !== true) return
        spend.addSeconds(bytes.length / STREAM_BYTES_PER_SECOND)
      })
      .catch((err: unknown) => failFlow(flow, reasonOf(String((err as Error)?.message ?? err))))
  }

  /** Takes exactly `n` samples off the flow's pending buffer. */
  function take(flow: Flow, n: number): Float32Array {
    const out = new Float32Array(n)
    let filled = 0
    while (filled < n && flow.pending.length > 0) {
      const head = flow.pending[0]!
      const need = n - filled
      if (head.length <= need) {
        out.set(head, filled)
        filled += head.length
        flow.pending.shift()
      } else {
        out.set(head.subarray(0, need), filled)
        flow.pending[0] = head.subarray(need)
        filled += need
      }
    }
    flow.pendingSamples -= filled
    return out
  }

  function handleEvent(flow: Flow, event: SttStreamEvent): void {
    if (flow.settled || flow.fallback) return
    switch (event.kind) {
      case "ready":
        markVoice("stt-open")
        return
      case "partial": {
        flow.provisional = event.text
        if (event.speechFinal) {
          if (event.text) flow.speechFinals.push(event.text)
          flow.finalPieces = []
        } else if (event.isFinal && event.text) {
          flow.finalPieces.push(event.text)
        }
        if (event.text) partialCb(event.text)
        return
      }
      case "done": {
        markVoice("stt-done", `${Math.round(event.durationS ?? 0)}s`)
        flow.doneText = event.text ?? ""
        const text = composed(flow)
        settle(flow)
        if (text) finalCb({ text, isFinal: true, confidence: 1.0, spokenAt: flow.spokenAt })
        return
      }
      case "failed":
        markVoice("stt-failed", event.reason)
        failFlow(flow, event.reason)
        return
    }
  }

  function onSegmentStart(event: SegmentAudio): void {
    const gate = options.nameGate
    const spokenAt = now()
    const gated = gate?.active(spokenAt) === true
    const streamable = !userStopped && !gated && streamAllowed()
    const flow: Flow = {
      sequence: event.sequence,
      spokenAt,
      gated,
      streamable,
      opened: false,
      openSettled: !streamable,
      socketGone: !streamable,
      released: !streamable,
      ended: false,
      fallback: false,
      settled: false,
      batching: false,
      speechFinals: [],
      finalPieces: [],
      provisional: "",
      doneText: "",
      pending: [],
      pendingSamples: 0,
    }
    flows.set(event.sequence, flow)
    if (!streamable) return
    /*
     * Its turn in the one-session chain: behind the previous session's close,
     * and only then does `transport.open` run. An abandonment before its turn
     * releases the chain without ever opening anything.
     */
    const previous = sessionTail
    let release!: () => void
    const closed = new Promise<void>((resolve) => {
      release = resolve
    })
    flow.release = release
    sessionTail = closed
    flow.openPromise = previous
      .then(() => {
        if (flow.settled || flow.fallback) {
          flow.openSettled = true
          noteSocketGone(flow)
          return
        }
        flow.opened = true
        return transport.open({
          ...(language ? { language } : {}),
          keyterms,
          onEvent: (streamEvent) => handleEvent(flow, streamEvent),
        })
      })
      .finally(() => {
        flow.openSettled = true
        maybeRelease(flow)
      })
    flow.openPromise.catch((err: unknown) => failFlow(flow, reasonOf(String((err as Error)?.message ?? err))))
  }

  function onSegmentFrame(event: SegmentAudio): void {
    const flow = flows.get(event.sequence)
    if (!flow || flow.settled || flow.fallback || !flow.streamable || flow.ended || !event.pcm) return
    flow.pending.push(event.pcm)
    flow.pendingSamples += event.pcm.length
    while (flow.pendingSamples >= STREAM_FRAME_SAMPLES) {
      send(flow, pcm16le(take(flow, STREAM_FRAME_SAMPLES)))
    }
  }

  function onSegmentEnd(event: SegmentAudio): void {
    const flow = flows.get(event.sequence)
    if (!flow || flow.settled) return
    flow.ended = true
    if (flow.fallback || !flow.streamable) {
      /*
       * The WAV is closed after this call, in the same turn of the event
       * loop, unless the capture threw the segment away as a transient. So
       * one microtask later the sentence either has its ammunition or is gone.
       */
      queueMicrotask(() => {
        if (!flow.settled && !flow.wav && !flow.batching) settle(flow)
      })
      return
    }
    if (flow.pendingSamples > 0) send(flow, pcm16le(take(flow, flow.pendingSamples)))
    void flow.openPromise!
      .then(() => {
        // Dropped before its turn or after: there is no session to end.
        if (flow.settled || flow.fallback) return
        return transport.end()
      })
      .catch((err: unknown) => failFlow(flow, reasonOf(String((err as Error)?.message ?? err))))
    flow.doneTimer = setTimeout(() => {
      if (flow.settled || flow.fallback || !flow.ended) return
      // No `transcript.done` after `audio.done`: this sentence goes to batch,
      // and the socket is not punished for it — no pause.
      markVoice("stt-done-timeout")
      failFlow(flow, "protocol")
    }, doneTimeoutMs)
  }

  function onSegmentCancel(event: SegmentAudio): void {
    const flow = flows.get(event.sequence)
    if (!flow) return
    if (flow.opened && !flow.settled) transport.cancel()
    settle(flow)
  }

  // -- The batch path ---------------------------------------------------------

  /**
   * Produces the sentence through the batch endpoint: whole for a turn, and —
   * while the gate waits for the name — by the same probe-then-whole dance
   * the OpenRouter backend does, because the room must not be transcribed.
   */
  async function runBatch(flow: Flow, segment: CapturedSegment): Promise<void> {
    if (flow.settled || flow.batching) return
    flow.batching = true
    const purposeInitial: TranscriberErrorPurpose = flow.gated ? "probe" : "turn"
    let purpose: TranscriberErrorPurpose = purposeInitial
    const spokenAt = flow.spokenAt
    const deliver = (text: string) => finalCb({ text, isFinal: true, confidence: 1.0, spokenAt })
    const report = (error: Error) => errorCb(error, { purpose })
    try {
      const gate = flow.gated ? options.nameGate : undefined
      if (!gate) {
        purpose = "turn"
        await batch({ segment, deliver, purpose, gated: false, report })
        markVoice("asr-back")
        return
      }
      const long = segment.durationMs > (gate.wholeUnderMs ?? NAME_PROBE_WHOLE_UNDER_MS)
      const head = long ? await wavHead(segment.blob, gate.probeMs ?? NAME_PROBE_MS) : undefined
      /* Waiting for the name, a long sentence goes whole only once its start
         has called; one that cannot be cut is not sent at all. */
      if (long && !head) {
        gate.onUncut?.()
        return
      }
      gate.onRequest?.()
      if (head) {
        let heard = ""
        await batch({
          segment: { ...segment, blob: head },
          deliver: (text) => (heard = text),
          purpose: "probe",
          gated: true,
          report,
        })
        markVoice("asr-probe-back", heard)
        if (!heard) return
        if (!gate.accepts(heard)) {
          gate.onRejected?.(heard)
          return
        }
        gate.onAccepted?.()
        gate.onRequest?.()
        purpose = "turn"
        await batch({ segment, deliver, purpose: "turn", gated: true, report })
        markVoice("asr-back")
        return
      }
      // Short enough to go whole: the one request is the probe, and whatever
      // it heard is what the sentence said.
      await batch({ segment, deliver, purpose: "probe", gated: true, report })
      markVoice("asr-back")
    } catch (err: any) {
      const safeMsg = sanitizeApiKey(err?.message ?? "errore sconosciuto", "")
      errorCb(new Error(`Non sono riuscito a trascrivere la frase: ${safeMsg}`), { purpose })
    } finally {
      settle(flow)
    }
  }

  // -- Capture wiring ---------------------------------------------------------

  micCapture.onSegmentAudio((event: SegmentAudio) => {
    switch (event.phase) {
      case "start":
        onSegmentStart(event)
        return
      case "frame":
        onSegmentFrame(event)
        return
      case "end":
        onSegmentEnd(event)
        return
      case "cancel":
        onSegmentCancel(event)
        return
    }
  })

  micCapture.onSegment((segment: CapturedSegment) => {
    if (segment.sequence === undefined) return
    const flow = flows.get(segment.sequence)
    if (!flow || flow.settled) return
    flow.wav = segment
    if (flow.fallback || !flow.streamable) {
      void runBatch(flow, segment)
      return
    }
    // Still streaming: the WAV is only held in case the stream gives up.
  })

  micCapture.onError((err: Error) => {
    errorCb(err, { purpose: "turn" })
  })

  return {
    get capture(): MicCapture {
      return micCapture
    },

    get hasInFlight(): boolean {
      return flows.size > 0
    },

    retryStreaming(): void {
      authLatched = false
      authWarned = false
      creditWarned = false
      creditUntil = 0
      retryAt = 0
      capWarned = false
    },

    startSegment(): void {
      micCapture.startSegment?.()
    },

    commit(): boolean {
      return Boolean(micCapture.commitSegment?.())
    },

    cancelSegment(): void {
      micCapture.cancelSegment?.()
    },

    finish(): void {
      // Closing the capture closes the open segment: `end` goes out, and the
      // sentence comes back over the stream while the caller waits on
      // `hasInFlight`.
      userStopped = true
      micCapture.stop()
    },

    async start(): Promise<void> {
      userStopped = false
      /*
       * No key is checked here on purpose: the key the socket needs lives on
       * the other side of the Tauri boundary, and the batch behind it has its
       * own. A missing key is a refusal the first sentence hears, not a wall
       * before the microphone opens.
       */
      try {
        await micCapture.start()
      } catch (err: any) {
        userStopped = true
        const lower = String(err?.message ?? "").toLowerCase()
        if (lower.includes("negato") || lower.includes("notallowed") || lower.includes("permission")) {
          const permErr = new MicPermissionDenied({
            message:
              "Accesso al microfono negato: consentilo nelle impostazioni di privacy del sistema (Windows: Impostazioni › Privacy e sicurezza › Microfono, per le app desktop).",
            cause: err,
          })
          errorCb(permErr as unknown as Error, { purpose: "turn" })
          throw permErr
        }
        if (lower.includes("nessun microfono") || lower.includes("notfound")) {
          const unavailErr = new MicUnavailable({
            message: "Nessun microfono rilevato o non accessibile. Collega un dispositivo audio e riprova.",
            cause: err,
          })
          errorCb(unavailErr as unknown as Error, { purpose: "turn" })
          throw unavailErr
        }
        const failure = new TranscriptionFailed({
          cause: err,
          message:
            plainProblem(err?.message) ?? `Non riesco ad aprire il microfono: ${err?.message ?? "non so perché"}`,
        })
        errorCb(failure as unknown as Error, { purpose: "turn" })
        throw failure
      }
    },

    stop(): void {
      userStopped = true
      /*
       * Discards: what the stream still owes is cancelled here, before the
       * capture closes, so a sentence on its way back lands on nobody — the
       * other half of `finish`, which lets those sentences come back.
       */
      for (const flow of flows.values()) {
        if (flow.opened && !flow.settled) transport.cancel()
        settle(flow)
      }
      micCapture.stop()
    },

    onPartial(callback: PartialTranscriptCallback): void {
      partialCb = callback
    },

    onFinal(callback: FinalTranscriptCallback): void {
      finalCb = callback
    },

    onError(callback: TranscriberErrorCallback): void {
      errorCb = callback
    },
  }
}
