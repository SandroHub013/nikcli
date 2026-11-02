import { describe, expect, test } from "bun:test"
import { intakeMail } from "./mail-intake"

describe("intakeMail", () => {
  test("the queue is written down right after the taking, before any answer is awaited", async () => {
    const log: string[] = []
    const queue: string[] = []
    await intakeMail({
      take: async () => [
        { id: "a", body: "ok" },
        { id: "b", body: "bad" },
        { id: "c", body: "ok" },
      ],
      accept: (id, body) => {
        if (body === "bad") return false
        queue.push(id)
        log.push(`accept ${id}`)
        return true
      },
      persist: () => log.push(`persist ${queue.join("")}`),
      refuse: async (id) => {
        await Promise.resolve()
        log.push(`refuse ${id}`)
      },
    })
    expect(log).toEqual(["accept a", "accept c", "persist ac", "refuse b"])
  })

  test("a crash during the refusals finds the accepted mail already written", async () => {
    let saved: string[] = []
    const queue: string[] = []
    const run = intakeMail({
      take: async () => [
        { id: "a", body: "ok" },
        { id: "b", body: "bad" },
      ],
      accept: (id, body) => (body === "ok" ? (queue.push(id), true) : false),
      persist: () => (saved = [...queue]),
      refuse: () => Promise.reject(new Error("killed")),
    })
    await run
    expect(saved).toEqual(["a"])
  })

  test("an empty outbox writes nothing and a failing take is an empty pass", async () => {
    let writes = 0
    const persist = () => void writes++
    expect(await intakeMail({ take: async () => [], accept: () => true, persist, refuse: async () => {} })).toBe(0)
    expect(
      await intakeMail({ take: () => Promise.reject(new Error("x")), accept: () => true, persist, refuse: async () => {} }),
    ).toBe(0)
    expect(writes).toBe(0)
  })
})
