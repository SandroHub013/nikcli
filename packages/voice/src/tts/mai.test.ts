import { describe, expect, test } from "bun:test"
import {
  MAI_ENDPOINT,
  MAI_SAMPLE_RATE,
  MAI_USD_PER_CHAR,
  createMaiBreaker,
  pcmToWav,
  reserveMai,
  speakMai,
  MaiError,
  type MaiClientDeps,
} from "./mai"
import { MAI_MODEL } from "../settings/reply-voices"

const PCM = new Uint8Array([0, 0, 1, 0, 2, 0, 3, 0])

function response(body: BodyInit | null, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      "content-type": "audio/pcm;rate=24000;channels=1",
      "x-generation-id": "gen-1",
      ...init.headers,
    },
  })
}

function client(fetchFn: MaiClientDeps["fetchFn"], over: Partial<MaiClientDeps> = {}): MaiClientDeps {
  return { apiKey: () => "key", fetchFn, ...over }
}

describe("MAI", () => {
  test("una frase esce come la richiesta provata, e torna WAV a 24 kHz", async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const fetchFn: MaiClientDeps["fetchFn"] = async (url, init) => {
      seen = { url: String(url), init: init! }
      return response(PCM)
    }
    const result = await speakMai({ voice: "it-IT-Rosa", text: "Ciao." }, client(fetchFn))
    expect(seen!.url).toBe(MAI_ENDPOINT)
    const body = JSON.parse(String(seen!.init.body))
    expect(body).toEqual({
      model: MAI_MODEL,
      input: "Ciao.",
      voice: "it-IT-Rosa:MAI-Voice-2.1-Flash",
      response_format: "pcm",
    })
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer key")
    expect(result.generationId).toBe("gen-1")
    expect(result.reservedUsd).toBe("Ciao.".length * MAI_USD_PER_CHAR)
    const view = new DataView(result.wav)
    expect(view.getUint32(24, true)).toBe(MAI_SAMPLE_RATE)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint16(34, true)).toBe(16)
    expect(result.wav.byteLength).toBe(44 + PCM.byteLength)
  })

  test("i pezzi dello stream si ricompongono senza perdere byte", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PCM.slice(0, 3))
        controller.enqueue(PCM.slice(3))
        controller.close()
      },
    })
    const fetchFn: MaiClientDeps["fetchFn"] = async () => response(stream)
    const result = await speakMai({ voice: "it-IT-Luca", text: "Uno." }, client(fetchFn))
    expect(new Uint8Array(result.wav).slice(44)).toEqual(PCM)
  })

  test("un content-type diverso non viene riprodotto", async () => {
    const fetchFn: MaiClientDeps["fetchFn"] = async () => response(PCM, { headers: { "content-type": "audio/mpeg" } })
    const error = await speakMai({ voice: "it-IT-Rosa", text: "Ciao." }, client(fetchFn)).catch((caught) => caught)
    expect(error).toBeInstanceOf(MaiError)
    expect(error.kind).toBe("format")
  })

  test("PCM di lunghezza dispari è rifiutato", async () => {
    const fetchFn: MaiClientDeps["fetchFn"] = async () => response(new Uint8Array([0, 1, 2]))
    const error = await speakMai({ voice: "it-IT-Rosa", text: "Ciao." }, client(fetchFn)).catch((caught) => caught)
    expect(error.kind).toBe("format")
  })

  test("niente audio è un errore, non un silenzio", async () => {
    const fetchFn: MaiClientDeps["fetchFn"] = async () => response(new Uint8Array())
    const error = await speakMai({ voice: "it-IT-Rosa", text: "Ciao." }, client(fetchFn)).catch((caught) => caught)
    expect(error.kind).toBe("empty")
  })

  test("senza chiave non parte nessuna richiesta", async () => {
    let called = 0
    const fetchFn: MaiClientDeps["fetchFn"] = async () => {
      called += 1
      return response(PCM)
    }
  })

  test("un abort prima della risposta non diventa un errore di rete", async () => {
    const controller = new AbortController()
    controller.abort()
    let called = 0
    const fetchFn: MaiClientDeps["fetchFn"] = async () => {
      called += 1
      return response(PCM)
    }
    const error = await speakMai(
      { voice: "it-IT-Rosa", text: "Ciao.", signal: controller.signal },
      client(fetchFn),
    ).catch((caught) => caught)
    expect(error.kind).toBe("aborted")
    expect(called).toBe(0)
  })

  test("il primo byte oltre il limite è un timeout, e la richiesta viene chiusa", async () => {
    let aborted = false
    const fetchFn: MaiClientDeps["fetchFn"] = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        })
      })
    const error = await speakMai(
      { voice: "it-IT-Rosa", text: "Ciao." },
      client(fetchFn, {
        schedule: () => Promise.reject(new MaiError("timeout", "scaduto")),
      }),
    ).catch((caught) => caught)
    expect(error.kind).toBe("timeout")
    expect(aborted).toBe(false)
  })

  test("la prenotazione è il prezzo di listino, in un solo posto", () => {
    expect(MAI_USD_PER_CHAR).toBe(0.000015)
    expect(reserveMai("")).toBe(0)
    expect(reserveMai("abcd")).toBeCloseTo(0.00006)
  })

  test("il WAV ha l'intestazione che il player si aspetta", () => {
    const wav = pcmToWav(PCM)
    const text = new TextDecoder().decode(new Uint8Array(wav).slice(0, 4))
    expect(text).toBe("RIFF")
  })
})

describe("il breaker", () => {
  test("un 402 lo chiude per 60 secondi, e Riprova lo riapre subito", () => {
    const breaker = createMaiBreaker()
    breaker.trip("payment", 1_000)
    expect(breaker.blocked(1_000 + 59_000)?.kind).toBe("payment")
    expect(breaker.blocked(1_000 + 60_000)).toBeUndefined()
    breaker.trip("payment", 2_000)
    breaker.retry()
    expect(breaker.blocked(2_000)).toBeUndefined()
  })

  test("un 401 resta chiuso finché non si riprova, un 429 onora il suo tempo", () => {
    const breaker = createMaiBreaker()
    breaker.trip("unauthorized", 0)
    expect(breaker.blocked(1_000_000_000)?.kind).toBe("unauthorized")
    breaker.trip("rate-limited", 0, 7_000)
    expect(breaker.blocked(6_999)?.kind).toBe("rate-limited")
    expect(breaker.blocked(7_000)).toBeUndefined()
  })

  test("una frase riuscita lo riapre", () => {
    const breaker = createMaiBreaker()
    breaker.trip("transient", 0)
    breaker.reset()
    expect(breaker.blocked(0)).toBeUndefined()
  })
})
