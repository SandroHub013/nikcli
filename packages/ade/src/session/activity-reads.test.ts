import { describe, expect, test } from "bun:test"
import { ACTIVITY_FRESH_MS, createActivityReads } from "./activity-reads"

function counted(files: Record<string, string | null>) {
  const calls = { many: 0, one: 0 }
  let clock = 0
  const reads = createActivityReads({
    readMany: async (nonces) => {
      calls.many++
      return nonces.map((nonce) => files[nonce] ?? null)
    },
    readOne: async (nonce) => {
      calls.one++
      return files[nonce] ?? null
    },
    now: () => clock,
  })
  return { reads, calls, advance: (ms: number) => (clock += ms) }
}

describe("the mail pass reads every session's activity in one call (P1-C2a)", () => {
  test("seven sessions, one invoke, each answer at its place", async () => {
    const files = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`n${i}`, `{"state":"idle","n":${i}}`]))
    const { reads, calls } = counted({ ...files, n3: null })
    const read = await reads.readAll(Object.keys(files))
    expect(calls).toEqual({ many: 1, one: 0 })
    expect(read[2]).toBe(`{"state":"idle","n":2}`)
    expect(read[3]).toBeNull()
  })

  test("a delivery in the same second uses what the pass read, and reads again after", async () => {
    const { reads, calls, advance } = counted({ a: `{"state":"busy"}` })
    await reads.readAll(["a"])
    advance(ACTIVITY_FRESH_MS - 1)
    expect(await reads.read("a")).toBe(`{"state":"busy"}`)
    expect(calls.one).toBe(0)
    advance(1)
    await reads.read("a")
    expect(calls.one).toBe(1)
  })

  test("a session the pass did not read is read, not guessed", async () => {
    const { reads, calls } = counted({ b: `{"state":"idle"}` })
    await reads.readAll(["a"])
    expect(await reads.read("b")).toBe(`{"state":"idle"}`)
    expect(calls.one).toBe(1)
  })

  test("a host without the batch command reads one by one, as before", async () => {
    let one = 0
    const reads = createActivityReads({ readOne: async () => (one++, null) })
    await reads.readAll(["a", "b"])
    expect(one).toBe(2)
  })
})
