import { describe, expect, test } from "bun:test"
import { createLineQueue } from "./line-queue"
import { lineIsTaken, timeNoteFor, type OpenRequest } from "./mailbox"

/*
 * Audit 0.7.7, B1: the time note was typed over an open permission prompt,
 * and its Enter confirmed whatever choice was selected. Every other line ADE
 * types checks for a prompt; this one checked only for a draft.
 */
describe("a time note never goes over a permission prompt (B1)", () => {
  const idle = { typing: false, permissionPending: false }
  const asking = { typing: false, permissionPending: true }

  test("with a prompt open the note is not due, and the round leaves timeNotes as it was", () => {
    const request: Pick<OpenRequest, "at" | "deliveredAt" | "budget" | "timeNotes"> = { at: 0, deliveredAt: 0, budget: 120 }
    // What the workbench does each round: type and mark only what is due.
    const round = (now: number, target: { typing: boolean; permissionPending: boolean }) => {
      const due = timeNoteFor(request, now, target)
      if (due) request.timeNotes = due
      return due
    }
    expect(round(61_000, asking)).toBeUndefined()
    expect(request.timeNotes).toBeUndefined()
    expect(round(62_000, asking)).toBeUndefined()
    expect(request.timeNotes).toBeUndefined()
    // The prompt is answered: the note goes, once.
    expect(round(63_000, idle)).toBe(1)
    expect(round(64_000, idle)).toBeUndefined()
    expect(request.timeNotes).toBe(1)
    // The end of the budget, again held by a prompt and then given once.
    expect(round(121_000, asking)).toBeUndefined()
    expect(request.timeNotes).toBe(1)
    expect(round(122_000, idle)).toBe(2)
    expect(round(123_000, idle)).toBeUndefined()
  })

  test("a draft still holds it, as before", () => {
    expect(timeNoteFor({ at: 0, budget: 120 }, 61_000, { typing: true, permissionPending: false })).toBeUndefined()
    expect(timeNoteFor({ at: 0, budget: 120 }, 61_000, idle)).toBe(1)
  })

  test("a prompt that opens while the note waits in the queue stops it at the moment of writing", async () => {
    const written: string[] = []
    const queue = createLineQueue()
    let target = idle
    // The workbench's job with `unlessBusy`: the check is made in the chain, just before writing.
    const guarded = (text: string) => async () => {
      if (lineIsTaken(target)) return false
      written.push(text, "\r")
      return true
    }
    const first = queue("p1", async () => {
      written.push("[Promemoria] A")
      // The agent asks for a permission while A waits for its Enter.
      target = asking
      await new Promise((resolve) => setTimeout(resolve, 5))
      written.push("\r")
      return true
    })
    const note = queue("p1", guarded("[Tempo] B"))
    expect(await first).toBe(true)
    expect(await note).toBe(false)
    expect(written).toEqual(["[Promemoria] A", "\r"])
  })
})
