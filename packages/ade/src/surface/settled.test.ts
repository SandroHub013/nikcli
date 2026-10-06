import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSettled } from "./settled"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("createSettled", () => {
  test("one that stays queued shows, and goes at once when it is taken", async () => {
    await createRoot(async (dispose) => {
      const [queued, setQueued] = createSignal(0)
      const settled = createSettled(queued, 30)
      setQueued(1)
      expect(settled()).toBe(0)
      await wait(50)
      expect(settled()).toBe(1)
      setQueued(2)
      expect(settled()).toBe(2)
      setQueued(0)
      expect(settled()).toBe(0)
      dispose()
    })
  })
})
