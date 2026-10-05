import { describe, expect, test } from "bun:test"
import { createMaiSpeaker, maiFallbackNotice, type MaiSpeakerDeps } from "./mai-speaker"
import { MaiError, type MaiClientDeps } from "./mai"

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
    expect(w.spoken.at(-1)).toContain("Seconda frase completa.")
  })

  test("prepare non esiste: il prefetch di una voce MAI non chiede nulla", () => {
    const w = world()
    const speaker = createMaiSpeaker(w.deps)
    speaker.prefetch?.("Ciao.")
    expect(w.fetchCount()).toBe(0)
  })
})
