import { describe, expect, test } from "bun:test"
import { createSttStreamTransport, type SttStreamBridge } from "./stt-stream"
import type { SttStreamEvent, SttStreamOpenOptions } from "@nikcli-ai/voice"
import { STT_STREAM_CANCELLED } from "@nikcli-ai/voice/core"

/** A fake Rust side: every call recorded, every open released by hand. */
function fakeBridge() {
  const opens: Array<{
    language: string | undefined
    keyterms: readonly string[]
    onEvent: (event: SttStreamEvent) => void
    id: number
  }> = []
  const sends: Array<{ id: number; bytes: Uint8Array }> = []
  const ends: number[] = []
  const cancels: number[] = []
  let nextId = 1
  let held: (() => void) | undefined
  let failure: Error | undefined

  const bridge: SttStreamBridge = {
    open(language, keyterms, onEvent) {
      if (failure) {
        const error = failure
        failure = undefined
        return Promise.reject(error)
      }
      const id = nextId++
      opens.push({ language, keyterms, onEvent, id })
      if (held) {
        return new Promise<number>((resolve) => {
          held = () => resolve(id)
        })
      }
      return Promise.resolve(id)
    },
    async send(id, bytes) {
      sends.push({ id, bytes })
    },
    async end(id) {
      ends.push(id)
    },
    async cancel(id) {
      cancels.push(id)
    },
  }

  return {
    bridge,
    opens,
    sends,
    ends,
    cancels,
    /** The next `open` stays pending until the test releases it. */
    holdNextOpen(): void {
      held = () => {}
    },
    releaseOpen(): void {
      held?.()
      held = undefined
    },
    failNextOpenWith(error: Error): void {
      failure = error
    },
    emit(index: number, event: SttStreamEvent): void {
      opens[index]!.onEvent(event)
    },
  }
}

const openOptions = (onEvent: (event: SttStreamEvent) => void): SttStreamOpenOptions => ({
  language: "it",
  keyterms: ["nik"],
  onEvent,
})

describe("stt-stream transport", () => {
  test("opens with language and keyterms, sends and ends against that session's id", async () => {
    const fake = fakeBridge()
    const transport = createSttStreamTransport(fake.bridge)
    const events: SttStreamEvent[] = []

    await transport.open(openOptions((event) => events.push(event)))
    await transport.send(new Uint8Array([1, 2, 3]))
    await transport.end()

    expect(fake.opens).toHaveLength(1)
    expect(fake.opens[0]!.language).toBe("it")
    expect(fake.opens[0]!.keyterms).toEqual(["nik"])
    expect(fake.sends).toEqual([{ id: 1, bytes: new Uint8Array([1, 2, 3]) }])
    expect(fake.ends).toEqual([1])

    fake.emit(0, { kind: "partial", text: "apri", isFinal: false, speechFinal: false })
    expect(events.map((event) => event.kind)).toEqual(["partial"])
  })

  test("done closes the session, so the next one opens", async () => {
    const fake = fakeBridge()
    const transport = createSttStreamTransport(fake.bridge)

    await transport.open(openOptions(() => {}))
    fake.emit(0, { kind: "done", text: "apri il browser", durationS: 1 })
    await transport.open(openOptions(() => {}))

    expect(fake.opens).toHaveLength(2)
    expect(fake.opens[1]!.id).toBe(2)
  })

  test("a failed open closes the session and says why", async () => {
    const fake = fakeBridge()
    const transport = createSttStreamTransport(fake.bridge)
    fake.failNextOpenWith(new Error("no-key"))

    await expect(transport.open(openOptions(() => {}))).rejects.toThrow("no-key")
    await transport.open(openOptions(() => {}))
    expect(fake.opens).toHaveLength(1)
  })

  test("a second open while one is live is refused out loud", async () => {
    const fake = fakeBridge()
    const transport = createSttStreamTransport(fake.bridge)

    await transport.open(openOptions(() => {}))
    await expect(transport.open(openOptions(() => {}))).rejects.toThrow(/una alla volta/i)
  })

  test("cancel before the id lands cancels for real once it does, and drops its events", async () => {
    const fake = fakeBridge()
    const transport = createSttStreamTransport(fake.bridge)
    const events: SttStreamEvent[] = []
    fake.holdNextOpen()

    const opening = transport.open(openOptions((event) => events.push(event)))
    transport.cancel()
    expect(fake.cancels).toEqual([])

    fake.releaseOpen()
    await opening
    expect(fake.cancels).toEqual([1])

    fake.emit(0, { kind: "partial", text: "non deve arrivare", isFinal: false, speechFinal: false })
    expect(events).toEqual([])
  })

  test("cancel after the id is known closes at once, without waiting for done", async () => {
    const fake = fakeBridge()
    const transport = createSttStreamTransport(fake.bridge)

    await transport.open(openOptions(() => {}))
    transport.cancel()
    expect(fake.cancels).toEqual([1])

    // No `done` will ever come: the session is already gone here.
    await transport.open(openOptions(() => {}))
    expect(fake.opens).toHaveLength(2)
  })

  test("cancel with nothing open is a shrug, not a crash", () => {
    const fake = fakeBridge()
    const transport = createSttStreamTransport(fake.bridge)
    expect(() => transport.cancel()).not.toThrow()
  })

  test("a send still on its way after a cancel says the session was cancelled, not lost (review S7, B2)", async () => {
    const fake = fakeBridge()
    const transport = createSttStreamTransport(fake.bridge)

    await transport.open(openOptions(() => {}))
    transport.cancel()
    await expect(transport.send(new Uint8Array([1]))).rejects.toThrow(STT_STREAM_CANCELLED)
    await expect(transport.end()).rejects.toThrow(STT_STREAM_CANCELLED)
    // A new session forgets it: a send with nothing open is again «no session».
    await transport.open(openOptions(() => {}))
    transport.cancel()
    await transport.open(openOptions(() => {}))
    fake.opens.at(-1)!.onEvent({ kind: "done", text: "" })
    await expect(transport.send(new Uint8Array([1]))).rejects.toThrow(/nessuna sessione/i)
  })

  test("sending or ending without a session says so instead of guessing", async () => {
    const fake = fakeBridge()
    const transport = createSttStreamTransport(fake.bridge)

    await expect(transport.send(new Uint8Array([1]))).rejects.toThrow(/nessuna sessione/i)
    await expect(transport.end()).rejects.toThrow(/nessuna sessione/i)
  })
})
