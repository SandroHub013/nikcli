import { describe, expect, test } from "bun:test"
import { createLineQueue } from "./line-queue"
import { deliveryResult, typeThenEnter } from "./enter"

describe("no text over a permission prompt (audit 0.7.7, MEDIO 1)", () => {
  test("a prompt already open: nothing is written, and the line is not typed", async () => {
    const written: string[] = []
    const outcome = await typeThenEnter({
      text: "[Messaggio da A]: ciao",
      write: (data) => written.push(data),
      wait: async () => {},
      alive: () => true,
      permissionOpen: () => true,
    })
    expect(outcome).toBe("not-typed")
    expect(written).toEqual([])
  })

  test("a line waiting in the queue while a prompt opens is not typed when its turn comes", async () => {
    const written: string[] = []
    const queue = createLineQueue()
    let prompt = false
    const line = (text: string, wait: () => Promise<void> = async () => {}) => () =>
      typeThenEnter({ text, write: (data) => written.push(data), wait, alive: () => true, permissionOpen: () => prompt })
    // A delivery checked the pane when it was queued, found it free, and waits behind A.
    const first = queue("p1", line("A", async () => {
      prompt = true
      await new Promise((resolve) => setTimeout(resolve, 5))
    }))
    const delivery = queue("p1", line("[Messaggio da B]: ciao"))
    expect(await first).toBe("typed-no-enter")
    expect(await delivery).toBe("not-typed")
    // Only A's text: the message did not land in the prompt's answer box.
    expect(written).toEqual(["A"])
  })
})

describe("deliveryResult", () => {
  test("not typed on a live session is held for a later round, not a closed session", () => {
    expect(deliveryResult("not-typed", true)).toBe("held")
    expect(deliveryResult("not-typed", false)).toBe("closed")
  })

  test("typed, with or without its Enter, is given", () => {
    expect(deliveryResult("sent", true)).toBe("given")
    expect(deliveryResult("typed-no-enter", true)).toBe("given")
  })

  test("a message already in the inbox is given: the inbox rings again, and typing it again would deliver it twice", () => {
    expect(deliveryResult("not-typed", true, true)).toBe("given")
    expect(deliveryResult("not-typed", false, true)).toBe("closed")
  })
})
