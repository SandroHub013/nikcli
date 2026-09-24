import { describe, expect, jest, test } from "bun:test"
import { createNaturalSpeaker, splitSentences, SILENCE_STOP_LIMIT_MS, type NaturalSpeakerDeps } from "./natural-speaker"
import { createFakeSpeaker } from "./speaker"

const wav = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer
const said = (buffer: ArrayBuffer) => new TextDecoder().decode(buffer)

function harness(overrides: Partial<NaturalSpeakerDeps> = {}) {
  const fallback = createFakeSpeaker()
  const played: string[] = []
  const installs: string[] = []
  const events: string[] = []
  const stops: number[] = []
  let installed = true
  const deps: NaturalSpeakerDeps = {
    voice: () => "ugo",
    status: async () => ({ supported: true, installed }),
    install: async (voice) => {
      installs.push(voice)
      installed = true
    },
    synthesize: async (_voice, text) => wav(text),
    play: async (buffer) => {
      played.push(said(buffer))
    },
    stop: async () => {
      stops.push(Date.now())
    },
    fallback,
    onInstall: (voice, state) => events.push(`${voice}:${state}`),
    ...overrides,
  }
  return { deps, fallback, played, installs, events, stops, setInstalled: (value: boolean) => (installed = value) }
}

describe("tts/natural-speaker", () => {
  test("sentences split on their end, not on a decimal point, and a short one joins the next", () => {
    expect(splitSentences("Fatto. Ho aperto la sessione 3.5 sui test! Ti avviso quando finisce?")).toEqual([
      "Fatto. Ho aperto la sessione 3.5 sui test!",
      "Ti avviso quando finisce?",
    ])
    expect(splitSentences("  una   sola frase senza punto ")).toEqual(["una sola frase senza punto"])
    expect(splitSentences("")).toEqual([])
  })

  test("an installed voice reads every sentence in order through Piper", async () => {
    const h = harness({
      // The second sentence comes back first: order is the reply's, not the host's.
      synthesize: (_voice, text) => new Promise((resolve) => setTimeout(() => resolve(wav(text)), text.startsWith("Ho") ? 20 : 1)),
    })
    await createNaturalSpeaker(h.deps).speak("Ho aperto una sessione Codex. Ti avviso quando ha finito.")
    expect(h.played).toEqual(["Ho aperto una sessione Codex.", "Ti avviso quando ha finito."])
    expect(h.fallback.spoken).toEqual([])
  })

  test("text asked for ahead is synthesised once, before its turn", async () => {
    const asked: string[] = []
    const h = harness({
      synthesize: async (_voice, text) => {
        asked.push(text)
        return wav(text)
      },
    })
    const speaker = createNaturalSpeaker(h.deps)
    await speaker.speak("Pronta la prima risposta.")
    speaker.prefetch?.("Seconda frase lunga. Terza frase lunga.")
    expect(asked).toEqual(["Pronta la prima risposta.", "Seconda frase lunga.", "Terza frase lunga."])
    await speaker.speak("Seconda frase lunga. Terza frase lunga.")
    expect(asked).toHaveLength(3)
    expect(h.played.slice(1)).toEqual(["Seconda frase lunga.", "Terza frase lunga."])
    // A cancel drops what was asked for ahead.
    speaker.prefetch?.("Quarta frase lunga.")
    speaker.cancel()
    await speaker.speak("Quarta frase lunga.")
    expect(asked.filter((t) => t === "Quarta frase lunga.")).toHaveLength(2)
  })

  test("a voice not downloaded yet speaks with the old voice and starts the download once", async () => {
    const h = harness()
    h.setInstalled(false)
    const speaker = createNaturalSpeaker(h.deps)
    await speaker.speak("Prima risposta.")
    await speaker.speak("Seconda risposta.")
    expect(h.fallback.spoken).toEqual(["Prima risposta."])
    expect(h.installs).toEqual(["ugo"])
    expect(h.events).toEqual(["ugo:downloading", "ugo:ready"])
    // Once ready, Piper answers.
    expect(h.played).toEqual(["Seconda risposta."])
  })

  test("the system voice, or a host without Piper, is the Web Speech voice", async () => {
    const system = harness({ voice: () => "system" })
    await createNaturalSpeaker(system.deps).speak("Ciao.")
    expect(system.fallback.spoken).toEqual(["Ciao."])

    const mac = harness({ status: async () => ({ supported: false, installed: false }) })
    await createNaturalSpeaker(mac.deps).speak("Ciao.")
    expect(mac.fallback.spoken).toEqual(["Ciao."])
    expect(mac.installs).toEqual([])
  })

  test("a sentence Piper fails leaves the rest of the reply to the old voice", async () => {
    const h = harness({
      synthesize: async (_voice, text) => {
        if (text.startsWith("Seconda")) throw new Error("Piper si è chiuso.")
        return wav(text)
      },
    })
    await createNaturalSpeaker(h.deps).speak("Prima frase lunga. Seconda frase lunga. Terza frase lunga.")
    expect(h.played).toEqual(["Prima frase lunga."])
    expect(h.fallback.spoken).toEqual(["Seconda frase lunga. Terza frase lunga."])
  })

  test("a Piper that never answers does not keep the reply silent: the old voice takes over", async () => {
    const h = harness({
      synthesisLimitMs: 30,
      synthesize: (_voice, text) => (text.startsWith("Seconda") ? new Promise<ArrayBuffer>(() => {}) : Promise.resolve(wav(text))),
    })
    await createNaturalSpeaker(h.deps).speak("Prima frase lunga. Seconda frase lunga.")
    expect(h.played).toEqual(["Prima frase lunga."])
    expect(h.fallback.spoken).toEqual(["Seconda frase lunga."])
  })

  test("a sentence synthesised but not playable is said in the old voice", async () => {
    const h = harness({
      play: async () => {
        throw new Error("play() rifiutato")
      },
    })
    await createNaturalSpeaker(h.deps).speak("Prima frase lunga. Seconda frase lunga.")
    expect(h.fallback.spoken).toEqual(["Prima frase lunga. Seconda frase lunga."])
  })

  test("prepare loads an installed voice once, silently, and starts the download of a missing one", async () => {
    const synthesized: string[] = []
    const h = harness({ synthesize: async (_voice, text) => (synthesized.push(text), wav(text)) })
    const speaker = createNaturalSpeaker(h.deps)
    speaker.prepare()
    await new Promise((resolve) => setTimeout(resolve, 5))
    speaker.prepare()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(synthesized).toEqual(["Pronto."])
    expect(h.played).toEqual([])

    const missing = harness()
    missing.setInstalled(false)
    createNaturalSpeaker(missing.deps).prepare()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(missing.installs).toEqual(["ugo"])
  })

  test("il primo token di due speaker non riparte da zero e non coincide", async () => {
    const first: number[] = []
    const collect = async (_voice: string, _text: string, token: number) => {
      first.push(token)
      return wav("Frase lunga abbastanza da non unirsi.")
    }
    const left = createNaturalSpeaker(harness({ synthesize: collect }).deps)
    const right = createNaturalSpeaker(harness({ synthesize: collect }).deps)
    await left.speak("Prima frase lunga del primo speaker.")
    await right.speak("Prima frase lunga del secondo speaker.")
    expect(first).toHaveLength(2)
    // A page reload must not hand back a number the host may still hold as abandoned.
    expect(first[0]).toBeGreaterThan(1_000_000)
    expect(first[1]).toBeGreaterThan(1_000_000)
    // Two speakers alive together never draw the same number either.
    expect(first[0]).not.toBe(first[1])
  })

  test("an abandoned reply cancels its queued sentences in the host, keeping the prefetched ones", async () => {
    const cancelled: number[][] = []
    const asked: { text: string; token: number }[] = []
    const held = new Map<string, (buffer: ArrayBuffer) => void>()
    const h = harness({
      synthesize: (_voice, text, token) => {
        asked.push({ text, token })
        if (text.startsWith("Vecchia")) {
          // Still queued in the host: it never settles on its own.
          return new Promise<ArrayBuffer>((resolve) => held.set(text, resolve))
        }
        return Promise.resolve(wav(text))
      },
      cancel: (tokens) => {
        cancelled.push(tokens)
      },
    })
    const speaker = createNaturalSpeaker(h.deps)
    const old = speaker.speak("Vecchia frase lunga. Vecchia altra frase lunga.")
    await new Promise((resolve) => setTimeout(resolve, 5))
    // Asked for ahead of the next reply, while the old one still runs.
    speaker.prefetch?.("Nuova frase pronta.")
    const prefetched = asked.find((entry) => entry.text === "Nuova frase pronta.")
    expect(prefetched).toBeDefined()

    await speaker.speak("Nuova risposta lunga.")
    expect(h.played).toEqual(["Nuova risposta lunga."])

    // One cancel, with exactly the two abandoned sentences — never the prefetched one.
    expect(cancelled).toHaveLength(1)
    const abandoned = new Set(asked.filter((entry) => entry.text.startsWith("Vecchia")).map((entry) => entry.token))
    expect(abandoned.size).toBe(2)
    expect(new Set(cancelled[0])).toEqual(abandoned)
    expect(cancelled[0]).not.toContain(prefetched!.token)

    // The old reply finds its sentences settled at last, and plays none of them.
    for (const resolve of held.values()) resolve(wav("x"))
    await old
    expect(h.played).toEqual(["Nuova risposta lunga."])
  })

  test("a new reply stops the one playing, and nothing of the old one plays after", async () => {
    let release: (() => void) | undefined
    const aborted: string[] = []
    const h = harness({
      play: (buffer, signal) =>
        new Promise<void>((resolve) => {
          const text = said(buffer)
          if (text.startsWith("Vecchia")) {
            signal.addEventListener("abort", () => {
              aborted.push(text)
              resolve()
            })
            release = resolve
          } else resolve()
        }),
    })
    const speaker = createNaturalSpeaker(h.deps)
    const old = speaker.speak("Vecchia risposta, prima frase. Vecchia risposta, seconda frase.")
    await new Promise((resolve) => setTimeout(resolve, 5))
    await speaker.speak("Nuova risposta.")
    release?.()
    await old
    expect(aborted).toEqual(["Vecchia risposta, prima frase."])
  })

  test("piper is shut down after 2 minutes of silence (P1-C4)", async () => {
    jest.useFakeTimers()
    try {
      const h = harness()
      const speaker = createNaturalSpeaker(h.deps)
      await speaker.speak("Prima frase della risposta.")
      expect(h.played).toEqual(["Prima frase della risposta."])
      expect(h.stops).toHaveLength(0)

      // 1 minute 59 seconds: still alive
      jest.advanceTimersByTime(119_000)
      expect(h.stops).toHaveLength(0)

      // 2 minutes of silence reached: stop is called
      jest.advanceTimersByTime(1_000)
      expect(h.stops).toHaveLength(1)

      // Further silence does not keep calling stop repeatedly
      jest.advanceTimersByTime(120_000)
      expect(h.stops).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })

  test("a new sentence within 2 minutes resets the silence timer", async () => {
    jest.useFakeTimers()
    try {
      const h = harness()
      const speaker = createNaturalSpeaker(h.deps)
      await speaker.speak("Prima frase.")
      expect(h.stops).toHaveLength(0)

      // 90 seconds pass (silence)
      jest.advanceTimersByTime(90_000)
      expect(h.stops).toHaveLength(0)

      // New sentence arrives before the 2-minute deadline
      await speaker.speak("Seconda frase.")
      expect(h.stops).toHaveLength(0)

      // 90 seconds pass after second sentence (total 180s from start): still alive because timer reset
      jest.advanceTimersByTime(90_000)
      expect(h.stops).toHaveLength(0)

      // Another 30 seconds pass (full 120s of silence since second sentence): shut down
      jest.advanceTimersByTime(30_000)
      expect(h.stops).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })

  test("a sentence arriving after shutdown restarts piper and is spoken", async () => {
    jest.useFakeTimers()
    try {
      const h = harness()
      const speaker = createNaturalSpeaker(h.deps)
      await speaker.speak("Prima frase.")
      jest.advanceTimersByTime(SILENCE_STOP_LIMIT_MS)
      expect(h.stops).toHaveLength(1)

      // Silence broken by a new sentence after shutdown:
      await speaker.speak("Frase dopo il silenzio.")
      expect(h.played).toEqual(["Prima frase.", "Frase dopo il silenzio."])

      // 2 minutes after this new sentence, it shuts down again:
      jest.advanceTimersByTime(SILENCE_STOP_LIMIT_MS)
      expect(h.stops).toHaveLength(2)
    } finally {
      jest.useRealTimers()
    }
  })

  test("a sentence arriving while shutdown is in flight still speaks (restart)", async () => {
    jest.useFakeTimers()
    try {
      let finishStop: (() => void) | undefined
      const h = harness({
        stop: () =>
          new Promise<void>((resolve) => {
            finishStop = resolve
          }),
      })
      const speaker = createNaturalSpeaker(h.deps)
      await speaker.speak("Prima frase.")

      // Advance to 2 minutes so stop() is triggered and in flight
      jest.advanceTimersByTime(SILENCE_STOP_LIMIT_MS)
      expect(finishStop).toBeDefined()

      // New sentence arrives while stop is still in flight:
      const pendingSpeak = speaker.speak("Frase mentre si sta chiudendo.")

      // Complete the shutdown
      finishStop!()
      await pendingSpeak

      expect(h.played).toEqual(["Prima frase.", "Frase mentre si sta chiudendo."])
    } finally {
      jest.useRealTimers()
    }
  })
})
