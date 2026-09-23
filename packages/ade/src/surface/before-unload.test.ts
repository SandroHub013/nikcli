import { describe, expect, test } from "bun:test"
import { mustConfirmLeaving, shouldConfirmWindowClose, closeConfirmationMessage } from "./before-unload"

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

describe("closing the window (D81, d81-chiusura)", () => {
  test("0 sessions working: closes immediately without asking", () => {
    expect(shouldConfirmWindowClose({ runningSessions: 0 })).toBe(false)
  })

  test("1 session working: asks confirmation with singular phrasing", () => {
    expect(shouldConfirmWindowClose({ runningSessions: 1 })).toBe(true)
    expect(closeConfirmationMessage(1)).toBe("1 sessione sta lavorando. Chiudere lo stesso?")
  })

  test("multiple sessions working: asks confirmation with plural phrasing", () => {
    expect(shouldConfirmWindowClose({ runningSessions: 3 })).toBe(true)
    expect(closeConfirmationMessage(3)).toBe("3 sessioni stanno lavorando. Chiudere lo stesso?")
  })
})

