import { describe, expect, test } from "bun:test"
import { retryingLoader } from "./lazy-load"

describe("an import that can be asked again", () => {
  test("a chunk that did not arrive is fetched again on the next ask, not kept as the answer for good", async () => {
    let calls = 0
    const load = retryingLoader(async () => {
      calls++
      if (calls === 1) throw new Error("chunk missing")
      return { default: "pane" }
    })
    await expect(load()).rejects.toThrow("chunk missing")
    expect(await load()).toEqual({ default: "pane" })
    expect(calls).toBe(2)
  })

  test("a chunk that arrived is kept: the pane opened twice imports once", async () => {
    let calls = 0
    const load = retryingLoader(async () => {
      calls++
      return calls
    })
    expect(await load()).toBe(1)
    expect(await load()).toBe(1)
    expect(calls).toBe(1)
  })

  test("two panes asking while it loads share one import", async () => {
    let calls = 0
    const load = retryingLoader(async () => {
      calls++
      return "x"
    })
    await Promise.all([load(), load()])
    expect(calls).toBe(1)
  })

  test("two asks that both failed each get the error, and the third starts over", async () => {
    let calls = 0
    const load = retryingLoader(async () => {
      calls++
      throw new Error(`attempt ${calls}`)
    })
    const both = await Promise.allSettled([load(), load()])
    expect(both.map((result) => result.status)).toEqual(["rejected", "rejected"])
    expect(calls).toBe(1)
    await expect(load()).rejects.toThrow("attempt 2")
  })
})
