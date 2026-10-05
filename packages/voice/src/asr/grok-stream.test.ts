import { describe, expect, test } from "bun:test"
import {
  createGrokStreamTranscriber,
  type GrokBatch,
  type GrokBatchRequest,
  type GrokStreamTranscriber,
  type SttStreamEvent,
  type SttStreamOpenOptions,
  type SttStreamTransport,
  type StreamSpend,
  type StreamState,
  STT_STREAM_CANCELLED,
} from "./grok-stream"
import { createMicCapture, encodeWav, type CapturedSegment, type SegmentAudio } from "../audio/capture"
import type { TranscriptEvent } from "./transcriber"
import type { NameGate } from "./openrouter"

const wavOf = (ms: number) => encodeWav(new Float32Array(Math.round((16000 * ms) / 1000)).fill(0.1), 16000)
const bytesFor = (ms: number) => Math.floor((16000 * ms) / 1000) * 2

interface Harness {
  transcriber: GrokStreamTranscriber
  opens: SttStreamOpenOptions[]
  sent: number[]
  order: string[]
  counts: { open: number; end: number; cancel: number }
  batches: GrokBatchRequest[]
  finals: TranscriptEvent[]
  partials: string[]
  errors: Array<{ message: string; purpose?: string }>
  startSeg: (sequence?: number) => void
  frames: (sequence: number, chunks: Float32Array[]) => void
  endSeg: (sequence?: number, kept?: boolean) => void
  cancelSeg: (sequence?: number) => void
  close: (sequence: number, ms: number) => void
  closeRaw: (segment: CapturedSegment) => void
  emit: (event: SttStreamEvent) => void
  tick: () => Promise<void>
}

function setup(
  options: {
    openError?: string
    answers?: string[]
    keyterms?: readonly string[]
    nameGate?: NameGate
    spend?: StreamSpend
    dailyCapUsd?: number | (() => number)
    onStreamState?: (state: StreamState) => void
    doneTimeoutMs?: number
    /** Milliseconds each `send` settles after, by call order: a slow transport. */
    sendDelays?: number[]
    /** Read when a send settles: a message makes it reject, as a transport cut under it would. */
    sendError?: () => string | undefined
    endDelayMs?: number
  } = {},
): Harness {
  const opens: SttStreamOpenOptions[] = []
  const sent: number[] = []
  const order: string[] = []
  let sendCalls = 0
  const counts = { open: 0, end: 0, cancel: 0 }
  const transport: SttStreamTransport = {
    open: async (opts) => {
      counts.open++
      opens.push(opts)
      if (options.openError) throw new Error(options.openError)
    },
    send: async (bytes) => {
      const delay = options.sendDelays?.[sendCalls++] ?? 0
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      const failure = options.sendError?.()
      if (failure) throw new Error(failure)
      sent.push(bytes.length)
      order.push("send")
    },
    end: async () => {
      const delay = options.endDelayMs ?? 0
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      counts.end++
      order.push("end")
    },
    cancel: () => {
      counts.cancel++
    },
  }

  let onAudio: ((event: SegmentAudio) => void) | null = null
  let onSegment: ((segment: CapturedSegment) => void | Promise<void>) | null = null
  const capture = createMicCapture({ mediaStream: { getTracks: () => [] } as any, isTypeSupported: () => true })
  capture.onSegmentAudio = (callback) => {
    onAudio = callback
  }
  capture.onSegment = (callback) => {
    onSegment = callback
  }

  const answers = [...(options.answers ?? ["batch"])]
  const batches: GrokBatchRequest[] = []
  const batch: GrokBatch = async (request) => {
    batches.push(request)
    const text = answers.shift() ?? ""
    if (text) request.deliver(text)
  }

  const finals: TranscriptEvent[] = []
  const partials: string[] = []
  const errors: Array<{ message: string; purpose?: string }> = []
  const transcriber = createGrokStreamTranscriber({
    transport,
    batch,
    capture,
    nameGate: options.nameGate,
    spend: options.spend,
    dailyCapUsd: options.dailyCapUsd,
    onStreamState: options.onStreamState,
    doneTimeoutMs: options.doneTimeoutMs,
    keyterms: options.keyterms,
    onPartial: (text) => partials.push(text),
    onFinal: (event) => finals.push(event),
    onError: (error, context) => errors.push({ message: error.message, purpose: context?.purpose }),
  })

  return {
    transcriber,
    opens,
    sent,
    order,
    counts,
    batches,
    finals,
    partials,
    errors,
    startSeg: (sequence = 1) => onAudio?.({ sequence, phase: "start" }),
    frames: (sequence, chunks) => chunks.forEach((pcm) => onAudio?.({ sequence, phase: "frame", pcm })),
    endSeg: (sequence = 1, kept = true) => onAudio?.({ sequence, phase: "end", kept }),
    cancelSeg: (sequence = 1) => onAudio?.({ sequence, phase: "cancel" }),
    close: (sequence, ms) =>
      onSegment?.({ blob: wavOf(ms), format: "wav", mimeType: "audio/wav", durationMs: ms, sequence }),
    closeRaw: (segment) => {
      void onSegment?.(segment)
    },
    emit: (event) => opens.at(-1)!.onEvent(event),
    tick: () => new Promise((resolve) => setTimeout(resolve, 0)),
  }
}

describe("asr/grok-stream streaming", () => {
  test("streams the sentence in 100 ms pieces and delivers from the socket, never sending the WAV", async () => {
    const h = setup({ keyterms: ["nik"] })
    await h.transcriber.start()

    h.startSeg(1)
    h.frames(1, [
      new Float32Array(800),
      new Float32Array(800),
      new Float32Array(800),
      new Float32Array(800),
    ])
    await h.tick()
    // 3200 samples at 16 kHz: two pieces of exactly 100 ms of PCM16LE.
    expect(h.sent).toEqual([3200, 3200])
    expect(h.opens[0]!.language).toBe("it")
    expect(h.opens[0]!.keyterms).toEqual(["nik"])

    h.emit({ kind: "partial", text: "apri il browser", isFinal: true, speechFinal: false })
    expect(h.partials).toEqual(["apri il browser"])

    h.endSeg(1)
    await h.tick()
    expect(h.counts.end).toBe(1)

    // The capture closes the segment anyway: the WAV is held, not sent.
    h.close(1, 2_000)
    h.emit({ kind: "done", text: "apri il browser" })

    expect(h.finals.map((event) => event.text)).toEqual(["apri il browser"])
    expect(h.finals[0]!.spokenAt).toBeGreaterThan(0)
    expect(h.batches).toHaveLength(0)
    expect(h.transcriber.hasInFlight).toBe(false)
  })

  test("one session at a time: the next socket opens only after the previous one closed", async () => {
    const h = setup()
    await h.transcriber.start()

    h.startSeg(1)
    await h.tick()
    expect(h.opens).toHaveLength(1)

    h.endSeg(1)
    h.close(1, 1_000)
    h.startSeg(2)
    await h.tick()
    // Session 1 has not closed yet: segment 2 waits its turn in the chain.
    expect(h.opens).toHaveLength(1)

    h.emit({ kind: "done", text: "prima frase" })
    await h.tick()
    expect(h.opens).toHaveLength(2)
    expect(h.finals.map((event) => event.text)).toEqual(["prima frase"])
  })

  test("composes the sentence from the pieces when the service settles on no text", async () => {
    const h = setup()
    await h.transcriber.start()

    h.startSeg(1)
    // The socket opens behind the one-session chain: a microtask, then it hears.
    await h.tick()
    h.emit({ kind: "partial", text: "prima frase", isFinal: true, speechFinal: true })
    h.emit({ kind: "partial", text: "seconda", isFinal: true, speechFinal: false })
    h.endSeg(1)
    h.close(1, 3_000)
    h.emit({ kind: "done", text: "" })

    expect(h.finals.map((event) => event.text)).toEqual(["prima frase seconda"])
    expect(h.batches).toHaveLength(0)
  })

  test("the last hypothesis is what is left when nothing else carried text, and silence delivers nothing", async () => {
    const h = setup()
    await h.transcriber.start()

    h.startSeg(1)
    await h.tick()
    h.emit({ kind: "partial", text: "forse questo", isFinal: false, speechFinal: false })
    h.endSeg(1)
    h.close(1, 1_000)
    h.emit({ kind: "done", text: "" })
    expect(h.finals.map((event) => event.text)).toEqual(["forse questo"])

    h.startSeg(2)
    await h.tick()
    h.endSeg(2)
    h.close(2, 1_000)
    h.emit({ kind: "done", text: "" })
    expect(h.finals).toHaveLength(1)
    expect(h.transcriber.hasInFlight).toBe(false)
  })

  test("a trailing piece smaller than 100 ms still goes out before the end", async () => {
    const h = setup()
    await h.transcriber.start()

    h.startSeg(1)
    h.frames(1, [new Float32Array(100)])
    await h.tick()
    expect(h.sent).toEqual([])
    h.endSeg(1)
    await h.tick()
    expect(h.sent).toEqual([200])
    expect(h.counts.end).toBe(1)
    h.transcriber.stop()
    expect(h.transcriber.hasInFlight).toBe(false)
  })

  test("finish lets the sentence on its way back come back", async () => {
    const h = setup()
    await h.transcriber.start()

    h.startSeg(1)
    await h.tick()
    h.transcriber.finish()
    expect(h.transcriber.hasInFlight).toBe(true)

    h.emit({ kind: "done", text: "ultima frase" })
    expect(h.finals.map((event) => event.text)).toEqual(["ultima frase"])
    expect(h.transcriber.hasInFlight).toBe(false)
  })
})

describe("asr/grok-stream counting the seconds and the cap", () => {
  test("every piece the socket carried is counted, in seconds", async () => {
    const counted: number[] = []
    const spend: StreamSpend = {
      costToday: () => 0,
      addSeconds: (seconds) => counted.push(seconds),
    }
    const h = setup({ spend })
    await h.transcriber.start()

    h.startSeg(1)
    h.frames(1, [new Float32Array(1600)])
    await h.tick()
    expect(counted).toHaveLength(1)
    expect(counted[0]).toBeCloseTo(0.1)

    h.endSeg(1)
    await h.tick()
    expect(counted).toHaveLength(1) // nothing was left over
  })

  test("over the cap no socket opens, the sentence goes to batch, and the warning is said once", async () => {
    const spend: StreamSpend = { costToday: () => 1, addSeconds: () => {} }
    const h = setup({ spend })
    await h.transcriber.start()

    h.startSeg(1)
    await h.tick()
    expect(h.opens).toHaveLength(0)
    h.close(1, 1_200)
    expect(h.batches).toHaveLength(1)
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]!.message).toContain("MAI-Transcribe-2")

    h.startSeg(2)
    h.close(2, 1_200)
    expect(h.batches).toHaveLength(2)
    expect(h.errors).toHaveLength(1)
  })

  test("the cap is read before every socket: raising it in the settings opens the next one", async () => {
    let cap = 0.5
    const spend: StreamSpend = { costToday: () => 0.6, addSeconds: () => {} }
    const h = setup({ spend, dailyCapUsd: () => cap })
    await h.transcriber.start()

    h.startSeg(1)
    await h.tick()
    expect(h.opens).toHaveLength(0)
    h.close(1, 1_200)

    cap = 1
    h.startSeg(2)
    await h.tick()
    expect(h.opens).toHaveLength(1)
  })
})

describe("asr/grok-stream state for the settings page", () => {
  test("says why the stream stopped, once per change, and «Riprova» says it is back", async () => {
    const states: StreamState[] = []
    const h = setup({ onStreamState: (state) => states.push(state) })
    expect(states).toEqual([{ kind: "ready" }])
    await h.transcriber.start()

    h.startSeg(1)
    await h.tick()
    h.emit({ kind: "failed", reason: "auth" })
    h.endSeg(1)
    h.close(1, 1_000)
    h.startSeg(2)
    await h.tick()
    h.close(2, 1_000)
    expect(states.map((state) => state.kind)).toEqual(["ready", "auth"])

    h.transcriber.retryStreaming()
    expect(states.at(-1)).toEqual({ kind: "ready" })
  })

  test("a rate refusal is a pause with its end, and the cap is said as the cap", async () => {
    const states: StreamState[] = []
    let cost = 0
    const spend: StreamSpend = { costToday: () => cost, addSeconds: () => {} }
    const h = setup({ spend, dailyCapUsd: 0.5, onStreamState: (state) => states.push(state) })
    await h.transcriber.start()

    h.startSeg(1)
    await h.tick()
    h.emit({ kind: "failed", reason: "rate" })
    h.endSeg(1)
    h.close(1, 1_000)
    const paused = states.at(-1)
    expect(paused?.kind).toBe("paused")
    expect(paused?.kind === "paused" && paused.until > Date.now()).toBe(true)

    h.transcriber.retryStreaming()
    cost = 0.5
    h.startSeg(2)
    await h.tick()
    h.close(2, 1_000)
    expect(states.at(-1)).toEqual({ kind: "cap" })
  })
})

describe("asr/grok-stream refusals", () => {
  test("a rate refusal sends this sentence to batch and closes the socket for the next minute", async () => {
    const h = setup()
    await h.transcriber.start()

    h.startSeg(1)
    await h.tick()
    h.emit({ kind: "failed", reason: "rate" })
    expect(h.counts.cancel).toBe(1)
    h.endSeg(1)
    h.close(1, 1_500)
    expect(h.batches).toHaveLength(1)
    expect(h.batches[0]!.purpose).toBe("turn")
    expect(h.batches[0]!.gated).toBe(false)
    expect(h.errors).toHaveLength(0) // a pause is not worth a word

    h.startSeg(2)
    await h.tick()
    expect(h.opens).toHaveLength(1) // still paused
    h.close(2, 1_500)
    expect(h.batches).toHaveLength(2)
  })

  test("an auth refusal latches with one warning, and «Riprova» clears it", async () => {
    const h = setup()
    await h.transcriber.start()

    h.startSeg(1)
    await h.tick()
    h.emit({ kind: "failed", reason: "auth" })
    h.endSeg(1)
    h.close(1, 1_000)
    expect(h.batches).toHaveLength(1)
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]!.message).toBe("La chiave xAI non funziona: trascrivo con MAI-Transcribe-2.")

    h.startSeg(2)
    await h.tick()
    expect(h.opens).toHaveLength(1)
    h.close(2, 1_000)
    expect(h.batches).toHaveLength(2)
    expect(h.errors).toHaveLength(1)

    h.transcriber.retryStreaming()
    h.startSeg(3)
    await h.tick()
    expect(h.opens).toHaveLength(2)
  })

  test("a protocol failure mid-sentence batches it without closing the socket for the next one", async () => {
    const h = setup()
    await h.transcriber.start()

    h.startSeg(1)
    await h.tick()
    h.emit({ kind: "failed", reason: "protocol" })
    h.endSeg(1)
    h.close(1, 2_000)
    expect(h.batches).toHaveLength(1)

    h.startSeg(2)
    await h.tick()
    expect(h.opens).toHaveLength(2)
  })

  test("no key on the machine: batch now, and the socket is tried again next sentence", async () => {
    const h = setup({ openError: "no-key" })
    await h.transcriber.start()

    h.startSeg(1)
    await h.tick()
    expect(h.errors).toHaveLength(0) // no key is the panel's business, not every phrase's
    h.endSeg(1)
    h.close(1, 1_000)
    expect(h.batches).toHaveLength(1)

    h.startSeg(2)
    await h.tick()
    expect(h.counts.open).toBe(2) // nothing latched
    h.close(2, 1_000)
    expect(h.batches).toHaveLength(2)
  })

  test("a session already open: batch at once, and the socket owes no silence", async () => {
    const h = setup({ openError: "Una sessione stt_stream è già aperta: una alla volta." })
    await h.transcriber.start()

    h.startSeg(1)
    await h.tick()
    // Local refusal: nothing reached the network, nothing is said aloud.
    expect(h.errors).toHaveLength(0)
    h.endSeg(1)
    h.close(1, 1_000)
    expect(h.batches).toHaveLength(1)

    // No pause follows: a rate or network failure would keep the socket
    // silence for tens of seconds, and segment 2 would not even try to open.
    h.startSeg(2)
    await h.tick()
    expect(h.counts.open).toBe(2)
    h.close(2, 1_000)
    expect(h.batches).toHaveLength(2)
  })

  test("no transcript.done after audio.done: the sentence goes to batch, with no pause", async () => {
    const h = setup({ doneTimeoutMs: 15 })
    await h.transcriber.start()

    h.startSeg(1)
    await h.tick()
    h.endSeg(1)
    h.close(1, 1_200)
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(h.batches).toHaveLength(1)
    // The batch produced it, not the socket: `done` never arrived.
    expect(h.finals.map((event) => event.text)).toEqual(["batch"])
    expect(h.counts.cancel).toBe(1)
    expect(h.transcriber.hasInFlight).toBe(false)
  })
})

describe("asr/grok-stream the gate", () => {
  const gateOf = (over: Partial<NameGate> = {}) => {
    const seen = { requests: 0, accepted: 0, rejected: 0, uncut: 0 }
    const gate: NameGate = {
      active: () => true,
      accepts: (text) => text.startsWith("ei nik"),
      onRequest: () => seen.requests++,
      onAccepted: () => seen.accepted++,
      onRejected: () => seen.rejected++,
      onUncut: () => seen.uncut++,
      ...over,
    }
    return { gate, seen }
  }

  test("while it waits for the name no socket opens: the start is probed, and the whole sentence follows only if it calls", async () => {
    const { gate, seen } = gateOf()
    const h = setup({ nameGate: gate, answers: ["ei nik apri", "ei nik apri il browser"] })
    await h.transcriber.start()

    h.startSeg(1)
    await h.tick()
    expect(h.opens).toHaveLength(0)

    h.close(1, 6_000)
    await h.tick()
    expect(h.batches).toHaveLength(2)
    expect(h.batches[0]!.purpose).toBe("probe")
    expect(h.batches[0]!.segment.blob.size).toBe(44 + bytesFor(1_500))
    expect(h.batches[1]!.purpose).toBe("turn")
    expect(h.batches[1]!.gated).toBe(true)
    expect(h.finals.map((event) => event.text)).toEqual(["ei nik apri il browser"])
    expect(seen).toEqual({ requests: 2, accepted: 1, rejected: 0, uncut: 0 })
  })

  test("a sentence from the room is probed once and shown as ignored", async () => {
    const { gate, seen } = gateOf()
    const h = setup({ nameGate: gate, answers: ["il governo ha approvato"] })
    await h.transcriber.start()

    h.startSeg(1)
    h.close(1, 8_000)
    await h.tick()
    expect(h.batches).toHaveLength(1)
    expect(h.batches[0]!.purpose).toBe("probe")
    expect(h.finals).toHaveLength(0)
    expect(seen.rejected).toBe(1)
  })

  test("a short sentence goes whole as its own probe, the way the batch path does today", async () => {
    const { gate, seen } = gateOf()
    const h = setup({ nameGate: gate, answers: ["ei nik stop"] })
    await h.transcriber.start()

    h.startSeg(1)
    h.close(1, 1_000)
    await h.tick()
    expect(h.batches).toHaveLength(1)
    expect(h.batches[0]!.purpose).toBe("probe")
    expect(h.batches[0]!.segment.durationMs).toBe(1_000)
    expect(h.finals.map((event) => event.text)).toEqual(["ei nik stop"])
    expect(seen.requests).toBe(1)
  })

  test("a long sentence that cannot be cut is not sent at all", async () => {
    const { gate, seen } = gateOf()
    const h = setup({ nameGate: gate })
    await h.transcriber.start()

    h.startSeg(1)
    h.closeRaw({ blob: new Blob(["webm bytes"]), format: "webm", mimeType: "audio/webm", durationMs: 5_000, sequence: 1 })
    await h.tick()
    expect(h.batches).toHaveLength(0)
    expect(seen.uncut).toBe(1)
    expect(h.finals).toHaveLength(0)
  })
})

describe("asr/grok-stream stopping", () => {
  test("a cancelled segment is dropped: the socket goes, nothing comes back", async () => {
    const h = setup()
    await h.transcriber.start()

    h.startSeg(1)
    await h.tick()
    h.frames(1, [new Float32Array(1600)])
    h.cancelSeg(1)
    expect(h.counts.cancel).toBe(1)
    expect(h.transcriber.hasInFlight).toBe(false)

    h.close(1, 1_000)
    await h.tick()
    expect(h.batches).toHaveLength(0)
    expect(h.finals).toHaveLength(0)
  })

  test("stop discards what the stream still owes", async () => {
    const h = setup()
    await h.transcriber.start()

    h.startSeg(1)
    await h.tick()
    h.endSeg(1)
    expect(h.transcriber.hasInFlight).toBe(true)

    h.transcriber.stop()
    expect(h.counts.cancel).toBe(1)
    expect(h.transcriber.hasInFlight).toBe(false)

    h.emit({ kind: "done", text: "mai consegnata" })
    h.close(1, 1_000)
    await h.tick()
    expect(h.finals).toHaveLength(0)
    expect(h.batches).toHaveLength(0)
  })

  test("a segment the capture threw away as a transient closes the socket and never becomes a turn", async () => {
    const h = setup()
    await h.transcriber.start()

    h.startSeg(1)
    await h.tick()
    h.frames(1, [new Float32Array(1600)])
    h.endSeg(1, false)
    await h.tick()

    // The socket dies without `audio.done`: there is no sentence to finish.
    expect(h.counts.cancel).toBe(1)
    expect(h.counts.end).toBe(0)
    expect(h.transcriber.hasInFlight).toBe(false)

    // Even if the service answers anyway, or the capture follows up late, the
    // noise stays silent: no final, no batch, no turn.
    h.emit({ kind: "done", text: "tosse", durationS: 0.1 })
    h.close(1, 1_000)
    await h.tick()
    expect(h.finals).toHaveLength(0)
    expect(h.batches).toHaveLength(0)
  })
})

describe("asr/grok-stream transport order", () => {
  test("frames and the end reach the transport in the order they were taken, even when it settles slowly", async () => {
    // The first call answers slowest: without a chain the second frame and
    // the end would overtake it, and the service would hear a scrambled tail.
    const h = setup({ sendDelays: [30, 0], endDelayMs: 0 })
    await h.transcriber.start()

    h.startSeg(1)
    await h.tick()
    h.frames(1, [new Float32Array(1600), new Float32Array(1600)])
    h.endSeg(1)
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(h.order).toEqual(["send", "send", "end"])
    expect(h.counts.end).toBe(1)
  })

  test("the partial keeps the pieces already fixed and shows only the latest provisional one", async () => {
    const h = setup()
    await h.transcriber.start()

    h.startSeg(1)
    await h.tick()
    h.emit({ kind: "partial", text: "prima", isFinal: false, speechFinal: false })
    h.emit({ kind: "partial", text: "prima parte", isFinal: true, speechFinal: false })
    h.emit({ kind: "partial", text: "seconda", isFinal: false, speechFinal: false })
    h.emit({ kind: "partial", text: "prima parte seconda", isFinal: false, speechFinal: true })
    h.emit({ kind: "partial", text: "ancora", isFinal: false, speechFinal: false })

    expect(h.partials).toEqual([
      "prima",
      "prima parte",
      "prima parte seconda",
      "prima parte seconda",
      "prima parte seconda ancora",
    ])
  })
})

describe("asr/grok-stream: the xAI key removed under a send in flight (review S7, B2-B3)", () => {
  test("the cut socket sends the sentence to the batch and owes no pause: the next one streams again", async () => {
    let cut = false
    const states: StreamState[] = []
    const h = setup({
      sendDelays: [30],
      sendError: () => (cut ? `${STT_STREAM_CANCELLED}: la sessione è stata annullata.` : undefined),
      onStreamState: (state) => states.push(state),
    })
    await h.transcriber.start()

    h.startSeg(1)
    await h.tick()
    expect(h.opens).toHaveLength(1)
    h.frames(1, [new Float32Array(1600)])
    // The page removes the key while that frame is on its way: the transport is cancelled under it.
    cut = true
    await new Promise((resolve) => setTimeout(resolve, 60))
    h.endSeg(1)
    h.close(1, 1_000)
    expect(h.batches).toHaveLength(1)
    expect(states.some((state) => state.kind === "paused")).toBe(false)

    cut = false
    h.startSeg(2)
    await h.tick()
    expect(h.opens).toHaveLength(2)
  })
})
