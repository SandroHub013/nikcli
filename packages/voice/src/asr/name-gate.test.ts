import { describe, expect, test } from "bun:test"
import { createOpenRouterTranscriber, NAME_PROBE_MS, wavHead, type NameGate } from "./openrouter"
import { createMicCapture, encodeWav } from "../audio/capture"
import { matchesWakeWord } from "../settings/wake-word"

const wavOf = (ms: number) => encodeWav(new Float32Array(Math.round((16000 * ms) / 1000)).fill(0.1), 16000)

/** One transcriber whose service answers from `answers`, in order, and records how much audio each request carried. */
function setup(answers: string[], gate: Partial<NameGate> & { active?: () => boolean } = {}) {
  const sent: number[] = []
  const finals: string[] = []
  const rejected: string[] = []
  const fetch = async (_url: unknown, init: any) => {
    const body = JSON.parse(init.body)
    sent.push(Buffer.from(body.input_audio.data, "base64").length - 44)
    return new Response(JSON.stringify({ text: answers.shift() ?? "" }), { status: 200 })
  }
  let segmentCb: any = null
  const capture = createMicCapture({ mediaStream: { getTracks: () => [] } as any, isTypeSupported: () => true })
  capture.onSegment = (cb: any) => {
    segmentCb = cb
  }
  const transcriber = createOpenRouterTranscriber({
    apiKey: "test-key",
    capture,
    fetch: fetch as any,
    onFinal: (event) => finals.push(event.text),
    nameGate: {
      active: gate.active ?? (() => true),
      accepts: (text) => matchesWakeWord(text, "ei nik").matched,
      onRejected: (text) => rejected.push(text),
    },
  })
  const hear = async (ms: number) => {
    await transcriber.start()
    await segmentCb({ blob: wavOf(ms), format: "wav", mimeType: "audio/wav", durationMs: ms })
  }
  return { sent, finals, rejected, hear }
}

const bytesFor = (ms: number) => Math.floor((16000 * ms) / 1000) * 2

describe("while it waits for the name, only the start of a sentence goes to the cloud", () => {
  test("a long sentence from the room costs one second and a half, and is shown as ignored", async () => {
    const { sent, finals, rejected, hear } = setup(["il governo ha approvato"])
    await hear(8_000)
    expect(sent).toEqual([bytesFor(NAME_PROBE_MS)])
    expect(finals).toEqual([])
    expect(rejected).toEqual(["il governo ha approvato"])
  })

  test("a long sentence that calls it is then sent whole", async () => {
    const { sent, finals, hear } = setup(["ehi nik raccontami", "ehi nik raccontami la storia di Roma"])
    await hear(6_000)
    expect(sent).toEqual([bytesFor(NAME_PROBE_MS), bytesFor(6_000)])
    expect(finals).toEqual(["ehi nik raccontami la storia di Roma"])
  })

  test("a short sentence is sent whole at once: cutting it would save nothing", async () => {
    const { sent, finals, hear } = setup(["ei nik stop"])
    await hear(1_800)
    expect(sent).toEqual([bytesFor(1_800)])
    expect(finals).toEqual(["ei nik stop"])
  })

  test("when the name is not needed — awake, answering, at work — the sentence goes whole", async () => {
    const { sent, finals, hear } = setup(["sì, chiudilo pure, grazie"], { active: () => false })
    await hear(5_000)
    expect(sent).toEqual([bytesFor(5_000)])
    expect(finals).toEqual(["sì, chiudilo pure, grazie"])
  })
})

describe("wavHead", () => {
  test("keeps the header valid for the shorter audio", async () => {
    const head = (await wavHead(wavOf(4_000), 1_500))!
    const view = new DataView(await head.arrayBuffer())
    expect(head.size).toBe(44 + bytesFor(1_500))
    expect(view.getUint32(4, true)).toBe(36 + bytesFor(1_500))
    expect(view.getUint32(40, true)).toBe(bytesFor(1_500))
    expect(view.getUint32(24, true)).toBe(16000)
  })

  test("leaves alone what it cannot cut", async () => {
    expect(
      await wavHead(new Blob(["not a wav file at all, just some bytes long enough to pass the size check"]), 1_500),
    ).toBeUndefined()
    expect(await wavHead(wavOf(1_000), 1_500)).toBeUndefined()
  })
})
