import { describe, expect, test } from "bun:test"
import { createLineQueue } from "./line-queue"
import { deliveryResult, enterAgain, typeThenEnter } from "./enter"

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

describe("the Enter pressed again: resend and re-ring (audit 0.7.7, MEDIO 2 and 3)", () => {
  const again = (state: { typing?: boolean; prompt?: boolean; alive?: boolean }, written: string[], queue = createLineQueue()) =>
    enterAgain({
      queue,
      key: "p1",
      write: (data) => written.push(`again:${JSON.stringify(data)}`),
      alive: () => state.alive ?? true,
      typing: () => state.typing ?? false,
      permissionOpen: () => state.prompt ?? false,
    })

  test("not while the user is writing a line: it would send it half done", async () => {
    const written: string[] = []
    expect(await again({ typing: true }, written)).toBe(false)
    expect(written).toEqual([])
  })

  test("not over a prompt, and not into a session that is gone", async () => {
    const written: string[] = []
    expect(await again({ prompt: true }, written)).toBe(false)
    expect(await again({ alive: false }, written)).toBe(false)
    expect(written).toEqual([])
  })

  test("otherwise pressed, as before", async () => {
    const written: string[] = []
    expect(await again({}, written)).toBe(true)
    expect(written).toEqual([`again:${JSON.stringify("\r")}`])
  })

  test("in the pane's queue: it never falls between another line's text and its Enter", async () => {
    const written: string[] = []
    const queue = createLineQueue()
    const line = queue("p1", () =>
      typeThenEnter({
        text: "B",
        write: (data) => written.push(`line:${JSON.stringify(data)}`),
        wait: () => new Promise((resolve) => setTimeout(resolve, 10)),
        alive: () => true,
        permissionOpen: () => false,
      }),
    )
    // The resend comes due while B waits for its Enter.
    const resend = again({}, written, queue)
    await Promise.all([line, resend])
    expect(written).toEqual([`line:${JSON.stringify("B")}`, `line:${JSON.stringify("\r")}`, `again:${JSON.stringify("\r")}`])
  })
})
