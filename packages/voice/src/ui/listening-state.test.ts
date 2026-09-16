import { describe, expect, test } from "bun:test"
import { listeningState } from "./listening-state"

const on = { alwaysListen: true, activation: "wake-word" as const, wakeWord: "ei nik" }

describe("the always-on indicator", () => {
  test("shown for as long as the microphone listens by itself, naming the phrase", () => {
    const state = listeningState({ settings: on, running: true, mode: "agent", paused: false })
    expect(state.kind).toBe("listening")
    expect(state.kind === "listening" && state.text).toBe("In ascolto · «ei nik»")
  })

  test("says when it has paused, so the user knows why it stopped answering", () => {
    const state = listeningState({ settings: on, running: false, mode: "agent", paused: true })
    expect(state.kind === "paused" && state.text).toBe("Ascolto in pausa: PC bloccato")
  })

  test("hidden when switched off, on another activation, during dictation, or closed by hand", () => {
    expect(
      listeningState({ settings: { ...on, alwaysListen: false }, running: true, mode: "agent", paused: false }).kind,
    ).toBe("hidden")
    expect(
      listeningState({ settings: { ...on, activation: "toggle" }, running: true, mode: "agent", paused: false }).kind,
    ).toBe("hidden")
    expect(listeningState({ settings: on, running: true, mode: "transcription", paused: false }).kind).toBe("hidden")
    expect(listeningState({ settings: on, running: false, mode: "agent", paused: false }).kind).toBe("hidden")
  })
})
