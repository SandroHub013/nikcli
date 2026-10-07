import { describe, expect, test } from "bun:test"
import {
  CLAIM_MS,
  WAIT_GRACE_MS,
  addWaiter,
  dropWaiters,
  dueWaiters,
  holdsDelivery,
  markWritten,
  parseWaiters,
  pruneWaiters,
  waiterFor,
  waitingFor,
  type DesignWaiter,
} from "./waiters"

const T0 = 1_791_000_000_000
const PATH = "C:/p/.ade/design.jsonl"
const AT = "2026-10-07T10:00:00.000Z"

const waiter = (id: string, timeout = 1800, now = T0, k = "DS-t2"): DesignWaiter =>
  waiterFor({ id, path: PATH, k, from: "n1-0", folder: `C:/p/.ade/design/${k}` }, timeout, now)

describe("who waits for a design choice", () => {
  test("a script waits until its own timeout, and a little longer for the receipt", () => {
    const list = [waiter("a", 60)]
    expect(waitingFor(list, PATH, "DS-t2", T0 + 60_000)).toHaveLength(1)
    expect(waitingFor(list, PATH, "DS-t2", T0 + 60_000 + WAIT_GRACE_MS + 1)).toEqual([])
    // Another key, another register: not waiting for this one.
    expect(waitingFor(list, PATH, "DS-altra", T0)).toEqual([])
    expect(waitingFor(list, "C:/q/.ade/design.jsonl", "DS-t2", T0)).toEqual([])
  })

  test("an answer written for a waiter holds its typed line for the claim window, then asks", () => {
    const written = markWritten([waiter("a")], ["a"], AT, T0)
    const answer = { path: PATH, k: "DS-t2", answeredAt: AT }
    expect(waitingFor(written, PATH, "DS-t2", T0)).toEqual([])
    expect(holdsDelivery(written, answer, T0 + CLAIM_MS - 1)).toBe(true)
    expect(dueWaiters(written, T0 + CLAIM_MS - 1)).toEqual([])
    expect(dueWaiters(written, T0 + CLAIM_MS).map((item) => item.id)).toEqual(["a"])
    // Still held once the window is over: the check that settles it is asynchronous, and a delivery pass beside it
    // typed the line the script had already printed (live in ADE Test). Only dropping the waiter lets it go.
    expect(holdsDelivery(written, answer, T0 + CLAIM_MS)).toBe(true)
    expect(holdsDelivery(written, answer, T0 + 60 * 60 * 1000)).toBe(true)
    expect(holdsDelivery(dropWaiters(written, ["a"]), answer, T0 + CLAIM_MS)).toBe(false)
    // Another answer of the same key (a later round) is not held by this one.
    expect(holdsDelivery(written, { ...answer, answeredAt: "2026-10-07T11:00:00.000Z" }, T0)).toBe(false)
    expect(dropWaiters(written, ["a"])).toEqual([])
  })

  test("with nobody waiting, nothing holds the line: it is typed as it always was", () => {
    expect(holdsDelivery([], { path: PATH, k: "DS-t2", answeredAt: AT }, T0)).toBe(false)
    // A script that gave up before the answer: not waiting, so nothing is written for it.
    const gone = [waiter("a", 2)]
    expect(waitingFor(gone, PATH, "DS-t2", T0 + 2_000 + WAIT_GRACE_MS + 1)).toEqual([])
  })

  test("the waits survive a reload: saved, read back, the same", () => {
    const list = addWaiter(markWritten([waiter("a"), waiter("b", 30)], ["a"], AT, T0), waiter("c"))
    const back = parseWaiters(JSON.stringify(list))
    expect(back).toEqual(list)
    // After a reload in the middle of a claim window the line is still held, and asked about once it ends.
    expect(holdsDelivery(back, { path: PATH, k: "DS-t2", answeredAt: AT }, T0 + 1_000)).toBe(true)
    expect(dueWaiters(back, T0 + CLAIM_MS).map((item) => item.id)).toEqual(["a"])
  })

  test("a broken store reads as no waits, and the same id is kept once", () => {
    expect(parseWaiters(null)).toEqual([])
    expect(parseWaiters("{rotto")).toEqual([])
    expect(parseWaiters('[{"id":"a"},null,3]')).toEqual([])
    expect(addWaiter([waiter("a", 10)], waiter("a", 20)).map((item) => item.until)).toEqual([waiter("a", 20).until])
  })

  test("prune keeps what can still matter", () => {
    const list = [waiter("vivo", 60), waiter("scaduto", 1), ...markWritten([waiter("scritto")], ["scritto"], AT, T0)]
    const later = T0 + 10_000
    expect(pruneWaiters(list, later).map((item) => item.id)).toEqual(["vivo", "scritto"])
    expect(pruneWaiters(list, T0 + 25 * 60 * 60 * 1000)).toEqual([])
  })
})
