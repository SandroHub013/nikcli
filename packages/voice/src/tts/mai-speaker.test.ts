import { describe, expect, test } from "bun:test"
import { createMaiSpeaker, maiFallbackNotice, type MaiSpeakerDeps } from "./mai-speaker"
import { MAI_DAILY_CAP_USD, MaiError, reserveMai, type MaiClientDeps } from "./mai"
import { createSpendTally } from "../settings/spend"

const PCM = new Uint8Array([0, 0, 1, 0])

function ok(): Response {
  return new Response(PCM, {
    headers: {
      "content-type": "audio/pcm;rate=24000;channels=1",
      "x-generation-id": "gen",
    },
  })
}

interface World {
  deps: MaiSpeakerDeps
  calls: string[]
  played: number
  spoken: string[]
  fetchCount: () => number
  setKey: (key: string | undefined) => void
  setStatus: (status: number) => void
}

function world(over: Partial<{ voice: string; key: string | undefined }> = {}): World {
  const calls: string[] = []
  const spoken: string[] = []
  let played = 0
  let key = over.key === undefined && !("key" in over) ? "key" : over.key
  let status = 200
  let fetches = 0
  const fetchFn: MaiClientDeps["fetchFn"] = async () => {
    fetches += 1
    calls.push(`fetch:${status}`)
    if (status !== 200) return new Response(null, { status })
    return ok()
  }
  const client: MaiClientDeps = { apiKey: () => key, fetchFn, now: () => 0 }
  const deps: MaiSpeakerDeps = {
    voiceFor: () => ({ voice: over.voice ?? "it-IT-Rosa", locale: "it-IT" }),
    hasKey: () => key !== undefined,
    client,
    play: async () => {
      played += 1
      calls.push("play")
    },
    local: {
      speak: async (text) => {
        spoken.push(text)
        calls.push(`local:${text}`)
      },
      cancel: () => calls.push("cancel"),
    },
    notice: (kind, hadKey) => maiFallbackNotice(kind, hadKey),
  }
  return {
    deps,
    calls,
    spoken,
    get played() {
      return played
    },
    fetchCount: () => fetches,
    setKey: (next) => {
      key = next
    },
    setStatus: (next) => {
      status = next
    },
  }
}

describe("MAI davanti alla voce locale", () => {
  test("una risposta italiana passa da MAI e non dalla voce locale", async () => {
    const w = world()
    const speaker = createMaiSpeaker(w.deps)
    await speaker.speak("Ciao, come va?")
    expect(w.played).toBe(1)
    expect(w.spoken).toEqual([])
    expect(w.fetchCount()).toBe(1)
  })

  test("una voce che non è MAI non fa nessuna richiesta", async () => {
    const w = world({ voice: "ugo" })
    await createMaiSpeaker(w.deps).speak("Ciao.")
    expect(w.fetchCount()).toBe(0)
    expect(w.spoken).toEqual(["Ciao."])
  })

  test("senza chiave va alla voce locale, in silenzio", async () => {
    const w = world({ key: undefined })
    const speaker = createMaiSpeaker(w.deps)
    await speaker.speak("Prima.")
    await speaker.speak("Seconda.")
    expect(w.fetchCount()).toBe(0)
    expect(w.spoken).toEqual(["Prima.", "Seconda."])
  })

  test("un 402 legge il resto con la voce locale e non riprova", async () => {
    const w = world()
    w.setStatus(402)
    await createMaiSpeaker(w.deps).speak("Prima frase. Seconda frase lunga.")
    expect(w.fetchCount()).toBe(1)
    expect(w.spoken[0]).toBe("Credito OpenRouter esaurito: uso la voce locale.")
    expect(w.spoken.at(-1)).toContain("Prima frase.")
  })

  test("un 429 apre il breaker: la risposta dopo non fa richieste", async () => {
    const w = world()
    w.setStatus(429)
    const speaker = createMaiSpeaker(w.deps)
    await speaker.speak("Prima.")
    await speaker.speak("Seconda.")
    expect(w.fetchCount()).toBe(1)
    expect(w.spoken.filter((text) => text.includes("non è disponibile"))).toHaveLength(1)
  })

  test("annullare durante la richiesta non fa parlare la voce locale", async () => {
    const w = world()
    let release: (() => void) | undefined
    w.deps.client.fetchFn = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(ok())
      })
    const speaker = createMaiSpeaker(w.deps)
    const pending = speaker.speak("Ciao, questa è una frase intera.")
    await Promise.resolve()
    speaker.cancel()
    release?.()
    await pending
    expect(w.spoken).toEqual([])
    expect(w.calls).toContain("cancel")
  })

  test("la chiave tolta fra una frase e l'altra ferma le richieste", async () => {
    const w = world()
    let fetches = 0
    w.deps.client.fetchFn = async () => {
      fetches += 1
      if (fetches === 1) w.setKey(undefined)
      return ok()
    }
    await createMaiSpeaker(w.deps).speak("Prima frase completa. Seconda frase completa.")
    expect(fetches).toBe(1)
    expect(w.played).toBe(1)
    expect(w.spoken).toEqual(["Manca la chiave OpenRouter: uso la voce locale.", "Seconda frase completa."])
  })

  test("una chiave rimessa si usa subito, senza aspettare", async () => {
    const w = world()
    const speaker = createMaiSpeaker(w.deps)
    w.deps.client.fetchFn = async () => {
      w.setKey(undefined)
      return ok()
    }
    await speaker.speak("Prima frase completa. Seconda frase completa.")
    w.setKey("key")
    let fetches = 0
    w.deps.client.fetchFn = async () => {
      fetches += 1
      return ok()
    }
    await speaker.speak("Una risposta nuova, con la chiave.")
    expect(fetches).toBe(1)
  })

  test("annullare chiude la richiesta in volo, che altrimenti si paga", async () => {
    const w = world()
    let seen: AbortSignal | undefined
    w.deps.client.fetchFn = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        seen = init.signal ?? undefined
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        )
      })
    // Nessuna scadenza: la richiesta si chiude perché si è annullato, non perché è passato il tempo.
    w.deps.client.schedule = () => new Promise<never>(() => {})
    const speaker = createMaiSpeaker(w.deps)
    const pending = speaker.speak("Ciao, questa è una frase intera.")
    await Promise.resolve()
    speaker.cancel()
    expect(seen?.aborted).toBe(true)
    await pending
    expect(w.spoken).toEqual([])
  })

  test("annullare ferma la frase che sta suonando", async () => {
    const w = world()
    let playing: AbortSignal | undefined
    let started: () => void = () => {}
    const begun = new Promise<void>((resolve) => (started = resolve))
    w.deps.play = (_wav, signal) =>
      new Promise<void>((resolve) => {
        playing = signal
        started()
        signal.addEventListener("abort", () => resolve())
      })
    const speaker = createMaiSpeaker(w.deps)
    const pending = speaker.speak("Ciao, questa è una frase intera. E questa è la seconda.")
    await begun
    speaker.cancel()
    await pending
    expect(playing?.aborted).toBe(true)
    // La seconda frase non viene chiesta.
    expect(w.fetchCount()).toBe(1)
  })

  test("una risposta nuova ferma quella che sta suonando", async () => {
    const w = world()
    const signals: AbortSignal[] = []
    let started: () => void = () => {}
    const begun = new Promise<void>((resolve) => (started = resolve))
    w.deps.play = (_wav, signal) =>
      new Promise<void>((resolve) => {
        signals.push(signal)
        if (signals.length === 1) {
          started()
          signal.addEventListener("abort", () => resolve())
        } else resolve()
      })
    const speaker = createMaiSpeaker(w.deps)
    const first = speaker.speak("Una risposta vecchia, ancora in corso.")
    await begun
    await speaker.speak("Una risposta nuova.")
    await first
    expect(signals[0]?.aborted).toBe(true)
    expect(signals).toHaveLength(2)
  })

  test("annullare durante l'avviso non fa ripartire il testo vecchio", async () => {
    const w = world()
    w.setStatus(402)
    let releaseNotice: () => void = () => {}
    let noticeStarted: () => void = () => {}
    const noticing = new Promise<void>((resolve) => (noticeStarted = resolve))
    w.deps.local.speak = async (text) => {
      w.spoken.push(text)
      if (text.startsWith("Credito")) {
        noticeStarted()
        await new Promise<void>((resolve) => (releaseNotice = resolve))
      }
    }
    const speaker = createMaiSpeaker(w.deps)
    const pending = speaker.speak("Prima frase completa. Seconda frase completa.")
    await noticing
    speaker.cancel()
    releaseNotice()
    await pending
    expect(w.spoken).toEqual(["Credito OpenRouter esaurito: uso la voce locale."])
  })

  test("markdown, link e fonti non vanno a MAI, che li farebbe pagare", async () => {
    const w = world()
    const inputs: string[] = []
    w.deps.client.fetchFn = async (_url, init) => {
      inputs.push(JSON.parse(String(init.body)).input)
      return ok()
    }
    await createMaiSpeaker(w.deps).speak(
      "Vedi [la guida](https://example.com/guida) per i dettagli. Fonti: https://example.com",
    )
    expect(inputs.join(" ")).toBe("Vedi la guida per i dettagli.")
  })

  test("prepare non esiste: il prefetch di una voce MAI non chiede nulla", () => {
    const w = world()
    const speaker = createMaiSpeaker(w.deps)
    speaker.prefetch?.("Ciao.")
    expect(w.fetchCount()).toBe(0)
  })
})

describe("la spesa della voce MAI", () => {
  const at = new Date(2026, 9, 5, 12).getTime()

  function withTally(w: World, tally = createSpendTally(null, at)) {
    w.deps.client.now = () => at
    w.deps.spend = { tally }
    return tally
  }

  test("la prenotazione è nel tally prima che parta la richiesta", async () => {
    const w = world()
    const tally = withTally(w)
    let seenBefore: number | undefined
    w.deps.client.fetchFn = async () => {
      seenBefore = tally.today(at).replyCalls
      return ok()
    }
    await createMaiSpeaker(w.deps).speak("Ciao, come va?")
    expect(seenBefore).toBe(1)
    expect(tally.today(at).replyCost).toBeCloseTo(reserveMai("Ciao, come va?"))
  })

  test("oltre il tetto non parte nessuna richiesta, e l'avviso è uno al giorno", async () => {
    const w = world()
    const tally = withTally(w)
    tally.addReply(at, MAI_DAILY_CAP_USD)
    const speaker = createMaiSpeaker(w.deps)
    await speaker.speak("Prima risposta.")
    await speaker.speak("Seconda risposta.")
    expect(w.fetchCount()).toBe(0)
    expect(w.spoken).toEqual([
      "Tetto di spesa della voce raggiunto: uso la voce locale.",
      "Prima risposta.",
      "Seconda risposta.",
    ])
  })

  test("il costo vero corregge la prenotazione, una volta sola", async () => {
    const w = world()
    const tally = withTally(w)
    let settled: () => void = () => {}
    const done = new Promise<void>((resolve) => (settled = resolve))
    w.deps.spend!.settle = async (id) => {
      expect(id).toBe("gen")
      queueMicrotask(settled)
      return 0.00001
    }
    await createMaiSpeaker(w.deps).speak("Ciao, come va?")
    await done
    await Promise.resolve()
    expect(tally.today(at).replyCost).toBeCloseTo(0.00001)
    expect(tally.today(at).settled).toEqual(["gen"])
  })

  test("un 402 restituisce la prenotazione e lo dice al pannello; Riprova lo riapre", async () => {
    const w = world()
    const tally = withTally(w)
    const states: (string | undefined)[] = []
    w.deps.onState = (kind) => states.push(kind)
    w.setStatus(402)
    const speaker = createMaiSpeaker(w.deps)
    await speaker.speak("Ciao, come va?")
    expect(tally.today(at).replyCost).toBeCloseTo(0)
    expect(tally.today(at).replyCalls).toBe(1)
    expect(states.at(-1)).toBe("payment")
    speaker.retry()
    expect(states.at(-1)).toBeUndefined()
  })
})
