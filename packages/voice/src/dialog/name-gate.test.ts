import { describe, expect, test } from "bun:test"
import { takesWithoutName, type NameGateInput } from "./name-gate"

const closed: NameGateInput = {
  mode: "agent",
  activation: "wake-word",
  awake: false,
  awaitingAnswer: false,
  thinking: false,
  pressed: false,
}

describe("takesWithoutName (D74)", () => {
  test("dictation never waits for the name", () => {
    expect(takesWithoutName({ ...closed, mode: "transcription" })).toBe(true)
  })

  test("the assistant with another activation does not either", () => {
    expect(takesWithoutName({ ...closed, activation: "push-to-talk" })).toBe(true)
    expect(takesWithoutName({ ...closed, activation: "toggle" })).toBe(true)
  })

  test("the assistant called by name, with nothing holding it open, drops the sentence", () => {
    expect(takesWithoutName(closed)).toBe(false)
  })

  for (const factor of ["awake", "awaitingAnswer", "thinking", "pressed"] as const) {
    test(`${factor} alone is enough to take it`, () => {
      expect(takesWithoutName({ ...closed, [factor]: true })).toBe(true)
    })
  }
})
