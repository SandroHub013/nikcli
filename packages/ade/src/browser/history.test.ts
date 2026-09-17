import { describe, expect, test } from "bun:test"
import { HISTORY_LIMIT, canStep, currentEntry, restoreHistory, startHistory, step, visit } from "./history"

const A = "https://a.test/"
const B = "https://b.test/"
const C = "https://c.test/"

describe("browser history", () => {
  test("a visit becomes the current entry", () => {
    const history = visit(startHistory(A), B)
    expect(history).toEqual({ entries: [A, B], index: 1 })
    expect(currentEntry(history)).toBe(B)
  })

  test("loading the page already shown adds nothing", () => {
    const history = startHistory(A)
    expect(visit(history, A)).toBe(history)
  })

  test("back and forward walk the list and stop at its ends", () => {
    const history = visit(visit(startHistory(A), B), C)
    const back = step(history, -1)
    expect(currentEntry(back)).toBe(B)
    expect(currentEntry(step(back, 1))).toBe(C)
    expect(step(history, 1)).toBe(history)
    const first = step(step(history, -1), -1)
    expect(canStep(first, -1)).toBe(false)
    expect(step(first, -1)).toBe(first)
  })

  test("a visit after going back drops what was ahead", () => {
    const history = visit(step(visit(visit(startHistory(A), B), C), -1), A)
    expect(history).toEqual({ entries: [A, B, A], index: 2 })
    expect(canStep(history, 1)).toBe(false)
  })

  test("the list is bounded", () => {
    let history = startHistory("https://0.test/")
    for (let i = 1; i < HISTORY_LIMIT + 10; i++) history = visit(history, `https://${i}.test/`)
    expect(history.entries).toHaveLength(HISTORY_LIMIT)
    expect(currentEntry(history)).toBe(`https://${HISTORY_LIMIT + 9}.test/`)
  })
})

describe("restoreHistory", () => {
  test("keeps a saved history whose current entry is the pane's URL", () => {
    expect(restoreHistory(B, { entries: [A, B, C], index: 1 })).toEqual({ entries: [A, B, C], index: 1 })
  })

  test("starts over from the URL on anything else", () => {
    for (const saved of [
      undefined,
      "x",
      { entries: [A, B], index: 0 },
      { entries: [A, 3], index: 0 },
      { entries: [B], index: 1 },
      { entries: [B], index: 0.5 },
      { entries: [B] },
    ]) {
      expect(restoreHistory(B, saved)).toEqual({ entries: [B], index: 0 })
    }
  })

  test("an oversized history keeps its tail, and its current entry if it is there", () => {
    const entries = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => `https://${i}.test/`)
    const last = entries.length - 1
    expect(restoreHistory(entries[last], { entries, index: last })).toEqual({
      entries: entries.slice(-HISTORY_LIMIT),
      index: HISTORY_LIMIT - 1,
    })
    expect(restoreHistory(entries[0], { entries, index: 0 })).toEqual({ entries: [entries[0]], index: 0 })
  })
})
