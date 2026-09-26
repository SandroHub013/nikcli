import { describe, expect, jest, test } from "bun:test"
import {
  createNaturalSpeaker,
  FIRST_SYNTHESIS_LIMIT_MS,
  splitSentences,
  SILENCE_STOP_LIMIT_MS,
  SYNTHESIS_LIMIT_MS,
  synthesisLimitMs,
  type NaturalSpeakerDeps,
} from "./natural-speaker"
import { createFakeSpeaker } from "./speaker"

const wav = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer
const said = (buffer: ArrayBuffer) => new TextDecoder().decode(buffer)

function harness(overrides: Partial<NaturalSpeakerDeps> = {}) {
  const fallback = createFakeSpeaker()
  const played: string[] = []
  const installs: string[] = []
  const events: string[] = []
  const stops: number[] = []
  /** The locale each synthesis was asked for, in the order they were asked. */
  const locales: string[] = []
  let installed = true
  const deps: NaturalSpeakerDeps = {
    voiceFor: () => ({ voice: "ugo", locale: "it-IT" }),
    status: async () => ({ supported: true, installed }),
    install: async (voice) => {
      installs.push(voice)
      installed = true
    },
    synthesize: async (_voice, text, _token, locale) => {
      locales.push(locale)
      return wav(text)
    },
    play: async (buffer) => {
      played.push(said(buffer))
    },
    stop: async () => {
      stops.push(Date.now())
      return { busy: false }
    },
    fallback,
    onInstall: (voice, state) => events.push(`${voice}:${state}`),
    ...overrides,
  }
  return { deps, fallback, played, installs, events, stops, locales, setInstalled: (value: boolean) => (installed = value) }
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

  test("a failed natural voice download stays failed until a later successful retry", async () => {
    let installed = false
    let attempts = 0
    const h = harness({
      status: async () => ({ supported: true, installed }),
      install: async () => {
        attempts++
        throw new Error("download interrupted")
      },
    })
    const speaker = createNaturalSpeaker(h.deps)

    await speaker.speak("Prima risposta.")
    await new Promise((resolve) => setTimeout(resolve, 0))
    await speaker.speak("Seconda risposta.")
    expect(attempts).toBe(1)
    expect(h.events).toEqual(["ugo:downloading", "ugo:failed"])

    installed = true
    await speaker.speak("Risposta dopo il retry.")
    expect(h.played).toEqual(["Risposta dopo il retry."])
    expect(attempts).toBe(1)
  })

  test("the system voice, or a host without Piper, is the Web Speech voice", async () => {
    const system = harness({ voiceFor: () => ({ voice: "system", locale: "it-IT" }) })
    await createNaturalSpeaker(system.deps).speak("Ciao.")
    expect(system.fallback.spoken).toEqual(["Ciao."])

    const mac = harness({ status: async () => ({ supported: false, installed: false }) })
    await createNaturalSpeaker(mac.deps).speak("Ciao.")
    expect(mac.fallback.spoken).toEqual(["Ciao."])
    expect(mac.installs).toEqual([])
  })

  test("cancelling while the fallback notice plays never speaks the abandoned reply", async () => {
    let releaseNotice: (() => void) | undefined
    let markNoticeStarted: (() => void) | undefined
    const noticeStarted = new Promise<void>((resolve) => {
      markNoticeStarted = resolve
    })
    const spoken: string[] = []
    const h = harness({
      status: async () => ({ supported: false, installed: false }),
      fallbackNotice: () => "Avviso naturale.",
      fallback: {
        speak: async (text) => {
          spoken.push(text)
          if (text === "Avviso naturale.") {
            markNoticeStarted?.()
            await new Promise<void>((resolve) => {
              releaseNotice = resolve
            })
          }
        },
        cancel: () => {},
      },
    })
    const speaker = createNaturalSpeaker(h.deps)
    const old = speaker.speak("Vecchia risposta lunga.")
    await noticeStarted
    speaker.cancel()
    releaseNotice?.()
    await old
    await speaker.speak("Nuova risposta lunga.")
    expect(spoken).toEqual(["Avviso naturale.", "Nuova risposta lunga."])
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

  test("the first sentence after a start has its own, longer limit", async () => {
    // Piper reads stdin once, after loading its model: that first answer is
    // the slow one, and the host waits 90 s for it.
    expect(synthesisLimitMs({ fresh: true })).toBe(FIRST_SYNTHESIS_LIMIT_MS)
    expect(synthesisLimitMs({ fresh: false })).toBe(SYNTHESIS_LIMIT_MS)
    // The client has to be the narrower of the two, or it gives up first.
    expect(FIRST_SYNTHESIS_LIMIT_MS).toBeLessThan(90_000)
    expect(SYNTHESIS_LIMIT_MS).toBeLessThan(30_000)
    // A test that sets the plain limit means it for every sentence, the first included.
    expect(synthesisLimitMs({ fresh: true, synthesisLimitMs: 30 })).toBe(30)
    expect(synthesisLimitMs({ fresh: false, firstSynthesisLimitMs: 40 })).toBe(SYNTHESIS_LIMIT_MS)
  })

  test("a first sentence slower than the later limit is still read by Piper", async () => {
    const h = harness({
      firstSynthesisLimitMs: 120,
      // 60 ms: past the 30 ms a test would set for a sentence that never answers.
      synthesize: (_voice, text) => new Promise((resolve) => setTimeout(() => resolve(wav(text)), 60)),
    })
    await createNaturalSpeaker(h.deps).speak("Prima frase lunga.")
    expect(h.played).toEqual(["Prima frase lunga."])
    expect(h.fallback.spoken).toEqual([])
  })

  test("once the host has answered, a sentence that stalls goes to the old voice again", async () => {
    const h = harness({
      firstSynthesisLimitMs: 5_000,
      synthesisLimitMs: 30,
      // The host answers the first sentence, then never answers the second.
      synthesize: (_voice, text) =>
        text.startsWith("Seconda") ? new Promise<ArrayBuffer>(() => {}) : Promise.resolve(wav(text)),
    })
    await createNaturalSpeaker(h.deps).speak("Prima frase lunga. Seconda frase lunga.")
    expect(h.played).toEqual(["Prima frase lunga."])
    expect(h.fallback.spoken).toEqual(["Seconda frase lunga."])
  })

  test("a voice that is broken rather than loading does not wait out the long limit", async () => {
    // A refusal is an answer: the next reply must not sit on the cold-start window.
    const h = harness({
      firstSynthesisLimitMs: 5_000,
      synthesisLimitMs: 30,
      synthesize: () => Promise.reject(new Error("Piper si è chiuso.")),
    })
    const started = Date.now()
    await createNaturalSpeaker(h.deps).speak("Prima frase lunga.")
    expect(h.fallback.spoken).toEqual(["Prima frase lunga."])
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("a new page stops a resident Piper before using it again", async () => {
    const h = harness()
    createNaturalSpeaker({ ...h.deps, stopOnCreate: true })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(h.stops).toHaveLength(1)
  })

  test("prepare loads an installed voice without downloading a missing one", async () => {
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
    expect(missing.installs).toEqual([])
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

  test("a stop the host calls busy does not hold a sentence that is already on its way, and the voice is freed after it", async () => {
    const events: string[] = []
    let busy = true
    const h = harness({
      stopRetryMs: 1,
      idleLimitMs: 5,
      stop: async () => {
        const stillBusy = busy
        busy = false
        events.push("stop")
        return { busy: stillBusy }
      },
      synthesize: async (_voice, text) => {
        events.push(text)
        return wav(text)
      },
    })
    const speaker = createNaturalSpeaker({ ...h.deps, stopOnCreate: true })
    await speaker.speak("Prima frase della risposta.")
    expect(h.played).toEqual(["Prima frase della risposta."])
    // One request at the host, which reported busy, and then the sentence: it
    // is not asked again, because what it would be freeing is the voice the
    // sentence is being made with.
    expect(events).toEqual(["stop", "Prima frase della risposta."])

    // And the voice is still freed later, when the silence comes back.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(events).toEqual(["stop", "Prima frase della risposta.", "stop"])
    speaker.prepare()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual(["stop", "Prima frase della risposta.", "stop", "Pronto."])
  })

  test("a stop that never confirms is given up on at its deadline, and the voice is not forgotten", async () => {
    const asked: string[] = []
    const stops: number[] = []
    const h = harness({
      stopRetryMs: 1,
      stopDeadlineMs: 20,
      idleLimitMs: 20,
      stop: async () => {
        stops.push(stops.length)
        return { busy: true }
      },
      synthesize: async (_voice, text) => {
        asked.push(text)
        return wav(text)
      },
    })
    const speaker = createNaturalSpeaker({ ...h.deps, stopOnCreate: true })
    speaker.prepare()
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(asked).toEqual(["Pronto."])
    speaker.prepare()
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(asked).toEqual(["Pronto."])
    await speaker.speak("Prima frase della risposta.")
    expect(h.played).toEqual(["Prima frase della risposta."])
    const before = stops.length
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(stops.length).toBeGreaterThan(before)
  })

  test("a sentence arriving while a busy stop is in flight does not wait the stop out", async () => {
    const stops: number[] = []
    const h = harness({
      stopRetryMs: 5,
      // Long enough that waiting it out would mean hundreds of requests, and
      // short enough that a regression costs the suite two seconds, not a hang.
      stopDeadlineMs: 2_000,
      stop: async () => {
        stops.push(stops.length)
        return { busy: true }
      },
    })
    const speaker = createNaturalSpeaker({ ...h.deps, stopOnCreate: true })
    // The page was still speaking when this speaker was made, so its stop finds
    // the host busy — and a reply is already on its way.
    await speaker.speak("Prima frase della risposta.")

    expect(h.played).toEqual(["Prima frase della risposta."])
    // One request, and then it is given up: the retries used to sit inside the
    // sentence's own limit, and a stop that never confirmed could spend all of
    // it and leave the reply in the system voice.
    expect(stops.length).toBeLessThanOrEqual(2)
  })

  test("a stop the host refuses does not silence the reply, and is asked again", async () => {
    const asked: string[] = []
    const stops: number[] = []
    const h = harness({
      idleLimitMs: 20,
      stop: async () => {
        stops.push(stops.length)
        throw new Error("il comando è fallito")
      },
      synthesize: async (_voice, text) => {
        asked.push(text)
        return wav(text)
      },
    })
    const speaker = createNaturalSpeaker({ ...h.deps, stopOnCreate: true })
    await new Promise((resolve) => setTimeout(resolve, 40))
    const before = stops.length
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(stops.length).toBeGreaterThan(before)
    speaker.prepare()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(asked).toEqual(["Pronto."])
    speaker.prepare()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(asked).toEqual(["Pronto."])
    await speaker.speak("Prima frase della risposta.")
    expect(h.played).toEqual(["Prima frase della risposta."])
  })

  test("a stop the silence caught in flight is asked again once it lets go", async () => {
    let release: ((answer: { busy: boolean }) => void) | undefined
    const stops: number[] = []
    const h = harness({
      idleLimitMs: 20,
      stopRetryMs: 5,
      stopDeadlineMs: 5_000,
      stop: () =>
        new Promise<{ busy: boolean }>((resolve) => {
          stops.push(stops.length)
          release = resolve
        }),
    })
    const speaker = createNaturalSpeaker(h.deps)
    await speaker.speak("Prima frase della risposta.")
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(stops).toHaveLength(1)
    release!({ busy: true })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(stops.length).toBeGreaterThan(1)
  })

  test("a warm-up asked while a stop was still busy leaves the voice resident, and it is stopped again", async () => {
    const asked: string[] = []
    const stops: number[] = []
    const h = harness({
      stopRetryMs: 1,
      idleLimitMs: 40,
      stop: async () => {
        stops.push(stops.length)
        return { busy: stops.length === 1 }
      },
      synthesize: async (_voice, text) => {
        asked.push(text)
        return wav(text)
      },
    })
    const speaker = createNaturalSpeaker({ ...h.deps, stopOnCreate: true })
    speaker.prepare()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(asked).toEqual(["Pronto."])
    expect(stops).toHaveLength(2)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(stops).toHaveLength(3)
  })

  test("a sentence arriving while shutdown is in flight still speaks (restart)", async () => {
    jest.useFakeTimers()
    try {
      let finishStop: (() => void) | undefined
      const h = harness({
        stop: () =>
          new Promise<{ busy: boolean }>((resolve) => {
            finishStop = () => resolve({ busy: false })
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
