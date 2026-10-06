import { afterEach, describe, expect, test } from "bun:test"
import { startMicTake } from "./mic"

/*
 * Full review 2026-10-06, nikverse B1: when `MediaRecorder` throws after `getUserMedia` succeeded, the stream's tracks were
 * left running, and the microphone stayed open (and lit) with no take to end it.
 */

const saved = {
  recorder: (globalThis as { MediaRecorder?: unknown }).MediaRecorder,
  devices: Object.getOwnPropertyDescriptor(navigator, "mediaDevices"),
}

afterEach(() => {
  ;(globalThis as { MediaRecorder?: unknown }).MediaRecorder = saved.recorder
  if (saved.devices) Object.defineProperty(navigator, "mediaDevices", saved.devices)
  else delete (navigator as { mediaDevices?: unknown }).mediaDevices
})

function fakeStream() {
  const stopped: boolean[] = []
  const tracks = [0, 1].map(() => ({ stop: () => stopped.push(true) }))
  return { stream: { getTracks: () => tracks }, stopped }
}

function install(stream: unknown, recorder: unknown) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => stream },
  })
  ;(globalThis as { MediaRecorder?: unknown }).MediaRecorder = recorder
}

describe("record/mic", () => {
  test("a recorder that cannot be built or started releases the microphone", async () => {
    const supported = { isTypeSupported: () => true }
    for (const when of ["constructor", "start"]) {
      const { stream, stopped } = fakeStream()
      class Broken {
        static isTypeSupported = supported.isTypeSupported
        state = "inactive"
        constructor() {
          if (when === "constructor") throw new Error("recorder")
        }
        addEventListener() {}
        start() {
          throw new Error("start")
        }
      }
      install(stream, Broken)
      await expect(startMicTake()).rejects.toThrow()
      expect(stopped).toHaveLength(2)
    }
  })

  test("a take that was stopped releases the tracks and gives the bytes", async () => {
    const { stream, stopped } = fakeStream()
    class Working {
      static isTypeSupported = () => true
      state = "recording"
      private handlers: Record<string, ((event: unknown) => void)[]> = {}
      addEventListener(name: string, handler: (event: unknown) => void) {
        ;(this.handlers[name] ??= []).push(handler)
      }
      start() {
        for (const handler of this.handlers.dataavailable ?? []) handler({ data: new Blob([new Uint8Array([1, 2, 3])]) })
      }
      stop() {
        this.state = "inactive"
        for (const handler of this.handlers.stop ?? []) handler({})
      }
    }
    install(stream, Working)
    const take = await startMicTake()
    expect(take).toBeDefined()
    const bytes = await take!.stop()
    expect(Array.from(bytes ?? [])).toEqual([1, 2, 3])
    expect(stopped).toHaveLength(2)
  })
})
