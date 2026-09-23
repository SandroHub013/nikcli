import { describe, expect, test } from "bun:test"
import { mustConfirmLeaving } from "./before-unload"

describe("leaving the page (audit 0.7.7, MEDIO 16)", () => {
  test("a running session asks first: a reload would end it mid-turn", () => {
    expect(mustConfirmLeaving({ unsavedBuffers: 0, runningSessions: 1 })).toBe(true)
  })

  test("an unsaved buffer asks, as before", () => {
    expect(mustConfirmLeaving({ unsavedBuffers: 2, runningSessions: 0 })).toBe(true)
  })

  test("nothing to lose: no question", () => {
    expect(mustConfirmLeaving({ unsavedBuffers: 0, runningSessions: 0 })).toBe(false)
  })
})
