import { describe, expect, test } from "bun:test"
import { createTakenMail } from "./mail-taken"

/*
 * RS2-5 B: the native side keeps a message until the page says it has it, and gives it back if the word does not come. So
 * the page can be handed the same message twice, and the agent must not be.
 */
const sealed = (mac: string, body: string) => `ade-mac1 ${mac.repeat(64)}\n${body}`

describe("a message given back is not carried out twice", () => {
  const round = (taken: ReturnType<typeof createTakenMail>, queue: string[], id: string, body: string) => {
    if (taken.isCopy(id, body)) return
    taken.handled(id, body)
    queue.push(id)
  }

  test("handed again by a take after its 30 s: one delivery", () => {
    const taken = createTakenMail()
    const queue: string[] = []
    round(taken, queue, "m1", "{}")
    round(taken, queue, "m1", "{}")
    round(taken, queue, "m1", "{}")
    expect(queue).toEqual(["m1"])
  })

  test("given back to a page that read it from its saved queue: not carried out again, whatever the seal says", () => {
    const taken = createTakenMail()
    const queue: string[] = []
    taken.restored("m2")
    round(taken, queue, "m2", "{}")
    expect(queue).toEqual([])
  })

  test("another file under the same id is not the same message", () => {
    const taken = createTakenMail()
    const queue: string[] = []
    round(taken, queue, "m3", "uno")
    round(taken, queue, "m3", "due")
    expect(queue).toEqual(["m3", "m3"])
  })

  test("two messages are two messages", () => {
    const taken = createTakenMail()
    const queue: string[] = []
    round(taken, queue, "m4", "{}")
    round(taken, queue, "m5", "{}")
    expect(queue).toEqual(["m4", "m5"])
  })

  test("the memory is bounded, oldest first", () => {
    const taken = createTakenMail(2)
    taken.handled("a", "x")
    taken.handled("b", "x")
    taken.handled("c", "x")
    expect(taken.isCopy("a", "x")).toBe(false)
    expect(taken.isCopy("c", "x")).toBe(true)
  })

  test("a sealed copy is told by its seal, so the body need not be kept", () => {
    const taken = createTakenMail()
    taken.handled("m6", sealed("a", '{"kind":"send"}'))
    expect(taken.isCopy("m6", sealed("a", '{"kind":"send"}'))).toBe(true)
    expect(taken.isCopy("m6", sealed("b", '{"kind":"send"}'))).toBe(false)
  })
})
