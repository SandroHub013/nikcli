import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { ACK_BATCH_BYTES, createAckBatcher, deliverChunk } from "./flow-ack"

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

/*
 * Review of ade/residui-gravi, RS-7 point 2: one IPC call per chunk is up to 62 a second per pane, and even a spinner
 * pays. A debt below the batch cannot block the host (its high water mark is far above), so no timer is needed.
 */
describe("createAckBatcher: few calls, never a debt the host cannot bear", () => {
  test("small acknowledgements are added up and sent once they reach the batch", () => {
    const sent: number[] = []
    const batch = createAckBatcher((bytes) => void sent.push(bytes))
    for (let i = 0; i < 10; i++) batch(1_000)
    expect(sent).toEqual([])
    batch(ACK_BATCH_BYTES)
    expect(sent).toEqual([10_000 + ACK_BATCH_BYTES])
  })

  test("a big chunk is sent at once, and the count starts again from nothing", () => {
    const sent: number[] = []
    const batch = createAckBatcher((bytes) => void sent.push(bytes))
    batch(ACK_BATCH_BYTES * 3)
    batch(5)
    batch(ACK_BATCH_BYTES)
    expect(sent).toEqual([ACK_BATCH_BYTES * 3, ACK_BATCH_BYTES + 5])
  })

  /*
   * The host's window is how far behind a key in another pane can fall, since events reach the page in order: a median
   * of 172 ms at 4 MiB and 140 ms at 1 MiB, against 32 ms at rest (live test of 2026-11-02). A batch has to fit in it
   * more than once, or the host waits for an acknowledgement the page is still adding up.
   */
  test("lint: the host's high water mark keeps a key close and has room for two batches", () => {
    const source = readFileSync(join(import.meta.dir, "..", "..", "src-tauri", "src", "pty.rs"), "utf8")
    const written = /const FLOW_HIGH_WATER: usize = ([\d* ]+);/.exec(source)?.[1]
    expect(written).toBeDefined()
    const high = written!.split("*").reduce((product, factor) => product * Number(factor), 1)
    expect(high).toBeLessThanOrEqual(1024 * 1024)
    expect(high).toBeGreaterThanOrEqual(2 * ACK_BATCH_BYTES)
  })
})
