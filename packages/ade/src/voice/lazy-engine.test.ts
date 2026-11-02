import { describe, expect, test } from "bun:test"
import { createEffect, createRoot, createSignal } from "solid-js"
import type { VoiceEngine, VoiceSettings } from "@ragu/voice/core"
import { DEFAULT_VOICE_SETTINGS } from "@ragu/voice/light"
import { createLazyVoiceEngine } from "./lazy-engine"

/** An engine that records what it was asked and answers like a running one. */
function fakeEngine() {
  const calls: string[] = []
  const [running, setRunning] = createSignal(false)
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      const given = args.filter((arg) => arg !== undefined)
      calls.push(`${name}${given.length ? `:${given.join(",")}` : ""}`)
      if (name === "start" || name === "toggle" || name === "pressToTalk") setRunning(true)
      if (name === "stop" || name === "releaseToTalk") setRunning(false)
    }
  const engine = {
    status: () => (running() ? "listening" : "idle"),
    partialTranscript: () => "ciao",
    history: () => [{ kind: "heard", text: "x" }],
    isRunning: running,
    settings: () => DEFAULT_VOICE_SETTINGS,
    start: record("start"),
    toggle: record("toggle"),
    submitText: record("submitText"),
    pressToTalk: record("pressToTalk"),
    releaseToTalk: record("releaseToTalk"),
    stop: record("stop"),
    cancel: record("cancel"),
    interrupt: record("interrupt"),
    pauseListening: record("pauseListening"),
    updateSettings: record("updateSettings"),
    handlePermissionResolved: record("handlePermissionResolved"),
    handlePermissionRequest: record("handlePermissionRequest"),
    openResponseWindow: record("openResponseWindow"),
    requestSendConfirmation: async () => true,
    retryStream: () => calls.push("retryStream"),
  } as unknown as VoiceEngine
  return { engine, calls }
}

function setup() {
  const real = fakeEngine()
  let loads = 0
  let release: (() => void) | undefined
  const settings: VoiceSettings = DEFAULT_VOICE_SETTINGS
  const lazy = createLazyVoiceEngine({
    settings: () => settings,
    load: () => {
      loads++
      return new Promise<{ engine: VoiceEngine; speaker: string }>((resolve) => {
        release = () => resolve({ engine: real.engine, speaker: "the speakers" })
        // Loaded at once unless a test wants to hold the load.
        if (!holdLoad) release()
      })
    },
  })
  return { lazy, real, loads: () => loads, release: () => release?.() }
}
let holdLoad = false

describe("a voice nobody has asked for", () => {
  test("answers as a silent voice would, and loads nothing", () => {
    const { lazy, loads } = setup()
    expect(lazy.isRunning()).toBe(false)
    expect(lazy.isBusy()).toBe(false)
    expect(lazy.status()).toBe("idle")
    expect(lazy.partialTranscript()).toBe("")
    expect(lazy.history()).toEqual([])
    expect(lazy.held()).toBeNull()
    expect(lazy.listenHalted()).toBe(false)
    expect(lazy.settings()).toBe(DEFAULT_VOICE_SETTINGS)
    expect(lazy.activeMode()).toBe(DEFAULT_VOICE_SETTINGS.mode)
    expect(lazy.loaded()).toBe(false)
    expect(loads()).toBe(0)
  })

  test("a stop, a cancel, a release and a settings change are not reasons to load it", async () => {
    const { lazy, loads } = setup()
    await lazy.stop()
    await lazy.cancel()
    await lazy.interrupt()
    await lazy.pauseListening()
    await lazy.releaseToTalk()
    await lazy.handlePermissionResolved("p1")
    await lazy.updateSettings({ speakReplies: false })
    lazy.retryStream()
    expect(loads()).toBe(0)
    expect(lazy.loaded()).toBe(false)
  })
})

describe("asking it to do something", () => {
  test("builds the engine once, however many ask at the same time", async () => {
    const { lazy, real, loads } = setup()
    await Promise.all([lazy.start("agent"), lazy.toggle("transcription"), lazy.submitText("ciao")])
    expect(loads()).toBe(1)
    expect(real.calls).toEqual(["start:agent", "toggle:transcription", "submitText:ciao"])
    expect(lazy.loaded()).toBe(true)
  })

  test("then reads the engine it built", async () => {
    const { lazy } = setup()
    await lazy.start("agent")
    expect(lazy.isRunning()).toBe(true)
    expect(lazy.status()).toBe("listening")
    expect(lazy.partialTranscript()).toBe("ciao")
    expect(lazy.history()).toHaveLength(1)
  })

  test("whatever drew the idle value draws the live one, without being told", async () => {
    const { lazy } = setup()
    const seen: boolean[] = []
    createRoot((dispose) => {
      createEffect(() => seen.push(lazy.isRunning()))
      return dispose
    })
    await Promise.resolve()
    expect(seen).toEqual([false])
    await lazy.start("agent")
    expect(seen.at(-1)).toBe(true)
  })

  test("a stop after the engine exists reaches it", async () => {
    const { lazy, real } = setup()
    await lazy.start("agent")
    await lazy.stop()
    expect(real.calls).toEqual(["start:agent", "stop"])
    expect(lazy.isRunning()).toBe(false)
  })

  test("a failed load is not kept: the next request tries again", async () => {
    let attempts = 0
    const told: string[] = []
    const real = fakeEngine()
    const lazy = createLazyVoiceEngine({
      settings: () => DEFAULT_VOICE_SETTINGS,
      load: async () => {
        attempts++
        if (attempts === 1) throw new Error("chunk missing")
        return { engine: real.engine }
      },
      onLoadError: (error) => told.push(String(error)),
    })
    await expect(lazy.start("agent")).rejects.toThrow("chunk missing")
    // The user is told once per failed load, not left with a chord that did nothing.
    expect(told).toEqual(["Error: chunk missing"])
    expect(lazy.loaded()).toBe(false)
    await lazy.start("agent")
    expect(attempts).toBe(2)
    expect(lazy.loaded()).toBe(true)
  })
})

describe("a key let go while the engine is still loading", () => {
  test("waits for the load, so the release comes after the press it follows", async () => {
    holdLoad = true
    try {
      const { lazy, real, release } = setup()
      const pressed = lazy.pressToTalk("agent")
      const released = lazy.releaseToTalk()
      release()
      await Promise.all([pressed, released])
      expect(real.calls).toEqual(["pressToTalk:agent", "releaseToTalk"])
      expect(lazy.isRunning()).toBe(false)
    } finally {
      holdLoad = false
    }
  })
})

describe("the speakers and the engine are one build", () => {
  test("the speakers are taken through the same door, so the engine they build is the one that is updated", async () => {
    const { lazy, real, loads } = setup()
    // «Prova», a voice download or a spoken alert asks for the speakers before anything asks for the microphone.
    const runtime = await lazy.runtime()
    expect(runtime.speaker).toBe("the speakers")
    expect(lazy.loaded()).toBe(true)
    // A key or a microphone saved afterwards must reach the engine the orb will start.
    await lazy.updateSettings({ speakReplies: false })
    expect(real.calls).toEqual(["updateSettings:[object Object]"])
    expect(loads()).toBe(1)
  })

  test("asking for the speakers and for the engine builds once, whichever comes first", async () => {
    const { lazy, loads } = setup()
    const [runtime, engine] = await Promise.all([lazy.runtime(), lazy.ensure()])
    expect(engine).toBe(runtime.engine)
    expect(loads()).toBe(1)
  })

  test("opening the settings panel builds the engine, so the spend it shows is the engine's and not a zero", async () => {
    const { lazy, loads } = setup()
    expect(lazy.listenSpend().calls).toBe(0)
    await lazy.ensure()
    expect(loads()).toBe(1)
    expect(lazy.loaded()).toBe(true)
  })
})
