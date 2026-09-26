import { describe, expect, test } from "bun:test"
import { playWav } from "./wav-player"

/** Nothing here decodes audio, and the meter is left out so `wavEnvelope` is not in the way. */
const wav = new ArrayBuffer(8)

/**
 * The player hands the WAV to an `<audio>` element and waits for it to end. The
 * element here answers immediately and can refuse the device the user chose,
 * which is the whole subject of these tests.
 */
function world() {
  const state = { played: 0, refuse: false }
  const ended = new Set<() => void>()
  class FakeAudio {
    currentTime = 0
    private handlers: Array<[string, () => void]> = []
    addEventListener(name: string, handler: () => void) {
      this.handlers.push([name, handler])
      if (name === "ended") ended.add(handler)
    }
    removeEventListener(name: string) {
      if (name === "ended") for (const handler of this.handlers) ended.delete(handler[1])
    }
    removeAttribute() {}
    pause() {}
    setSinkId(): Promise<void> {
      return state.refuse ? Promise.reject(new Error("dispositivo non trovato")) : Promise.resolve()
    }
    play(): Promise<void> {
      state.played++
      for (const handler of [...ended]) queueMicrotask(handler)
      return Promise.resolve()
    }
  }
  const original = { Audio: globalThis.Audio, create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  globalThis.Audio = FakeAudio as unknown as typeof Audio
  URL.createObjectURL = () => "blob:wav"
  URL.revokeObjectURL = () => {}
  return {
    state,
    restore: () => {
      globalThis.Audio = original.Audio
      URL.createObjectURL = original.create
      URL.revokeObjectURL = original.revoke
    },
  }
}

describe("la voce sul dispositivo scelto", () => {
  test("un dispositivo che non c'è si dice una volta, e la risposta suona lo stesso", async () => {
    const w = world()
    try {
      w.state.refuse = true
      const lost: string[] = []
      const signal = new AbortController().signal
      await playWav(wav, signal, "cuffie-di-luca", undefined, (device) => lost.push(device))
      await playWav(wav, signal, "cuffie-di-luca", undefined, (device) => lost.push(device))
      expect(lost, "un avviso per dispositivo, non uno per frase").toEqual(["cuffie-di-luca"])
      expect(w.state.played, "il dispositivo mancante non perde la risposta").toBe(2)
    } finally {
      w.restore()
    }
  })

  test("un altro dispositivo che sparisce si dice a sua volta", async () => {
    const w = world()
    try {
      w.state.refuse = true
      const lost: string[] = []
      const signal = new AbortController().signal
      await playWav(wav, signal, "cuffie-di-marta", undefined, (device) => lost.push(device))
      expect(lost).toEqual(["cuffie-di-marta"])
    } finally {
      w.restore()
    }
  })

  test("un dispositivo che risponde non viene annunciato", async () => {
    const w = world()
    try {
      const lost: string[] = []
      const signal = new AbortController().signal
      await playWav(wav, signal, "cuffie-di-paolo", undefined, (device) => lost.push(device))
      expect(lost).toEqual([])
      expect(w.state.played).toBe(1)
    } finally {
      w.restore()
    }
  })

  test("un dispositivo che torna e poi si stacca di nuovo si dice due volte", async () => {
    const w = world()
    try {
      const lost: string[] = []
      const signal = new AbortController().signal
      // Headphones unplugged: said once.
      w.state.refuse = true
      await playWav(wav, signal, "cuffie-di-greta", undefined, (device) => lost.push(device))
      // Plugged back in: the notice is not standing any more.
      w.state.refuse = false
      await playWav(wav, signal, "cuffie-di-greta", undefined, (device) => lost.push(device))
      // And unplugged a second time, that is news again.
      w.state.refuse = true
      await playWav(wav, signal, "cuffie-di-greta", undefined, (device) => lost.push(device))
      expect(lost).toEqual(["cuffie-di-greta", "cuffie-di-greta"])
    } finally {
      w.restore()
    }
  })

  test("il dispositivo di sistema non viene mai detto mancante", async () => {
    const w = world()
    try {
      w.state.refuse = true
      const lost: string[] = []
      const signal = new AbortController().signal
      await playWav(wav, signal, undefined, undefined, (device) => lost.push(device))
      expect(lost).toEqual([])
      expect(w.state.played).toBe(1)
    } finally {
      w.restore()
    }
  })
})
