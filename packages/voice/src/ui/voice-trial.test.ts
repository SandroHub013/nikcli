import { describe, expect, test } from "bun:test"
import { submitVoiceTrial } from "./voice-trial"

describe("submitVoiceTrial", () => {
  test("submits text without opening the microphone", async () => {
    let submitted = ""
    let starts = 0
    const engine = {
      submitText: async (text: string) => void (submitted = text),
      start: async () => void starts++,
    }

    await submitVoiceTrial(engine, "apri la tavolozza")

    expect(submitted).toBe("apri la tavolozza")
    expect(starts).toBe(0)
  })
})
