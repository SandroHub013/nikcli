import { describe, expect, test } from "bun:test"
import { deliverChunk } from "./flow-ack"

/*
 * Audit 2026-11-02, RS-7: nothing slowed a PTY whose page could not keep up, so memory grew until the renderer died.
 * The host now waits for the page to say how many bytes it has written into the terminal; this is the page's half.
 */
describe("deliverChunk: telling the host what the terminal has written", () => {
  test("a handler that only reads the chunk counts it as written when it returns", () => {
    const acked: number[] = []
    const seen: string[] = []
    deliverChunk({ data: "abc", bytes: 3 }, (chunk) => void seen.push(chunk), (bytes) => void acked.push(bytes))
    expect(seen).toEqual(["abc"])
    expect(acked).toEqual([3])
  })

  test("a handler that takes charge is believed only when it says the terminal wrote the chunk", () => {
    const acked: number[] = []
    let written: (() => void) | undefined
    deliverChunk(
      { data: "héllo", bytes: 6 },
      (_chunk, done) => {
        written = done
        return true
      },
      (bytes) => void acked.push(bytes),
    )
    expect(acked).toEqual([])
    written!()
    expect(acked).toEqual([6])
    // Said twice, counted once.
    written!()
    expect(acked).toEqual([6])
  })

  test("a handler that throws still pays the chunk, so the host is never left waiting for it", () => {
    const acked: number[] = []
    expect(() =>
      deliverChunk(
        { data: "x", bytes: 1 },
        () => {
          throw new Error("boom")
        },
        (bytes) => void acked.push(bytes),
      ),
    ).toThrow("boom")
    expect(acked).toEqual([1])
  })

  test("a chunk with no size, or no handler, says nothing to the host", () => {
    const acked: number[] = []
    deliverChunk({ data: "x" }, () => {}, (bytes) => void acked.push(bytes))
    deliverChunk({ data: "x", bytes: 0 }, () => {}, (bytes) => void acked.push(bytes))
    expect(acked).toEqual([])
    deliverChunk({ data: "xy", bytes: 2 }, undefined, (bytes) => void acked.push(bytes))
    expect(acked).toEqual([2])
  })
})
