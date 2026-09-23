import { describe, expect, test } from "bun:test"
import { createLineQueue } from "./line-queue"
import { lineIsTaken, timeNoteFor, type OpenRequest } from "./mailbox"
import { lineGiven, pressEnter, typeThenEnter, type LineOutcome } from "./enter"

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

  test("a prompt that opens while a line waits for its Enter: no Enter, and the note behind it is not typed", async () => {
    const written: string[] = []
    const queue = createLineQueue()
    let target = idle
    // The workbench's job with `unlessBusy`: the check is made in the chain, just before writing.
    const guarded = (text: string) => async () => {
      if (lineIsTaken(target)) return "not-typed" as LineOutcome
      return typeThenEnter({
        text,
        write: (data) => written.push(data),
        wait: async () => {},
        alive: () => true,
        permissionOpen: () => target.permissionPending,
      })
    }
    // A, as `typeLineNow` types it: the agent asks for a permission while A waits for its Enter.
    const first = queue("p1", () =>
      typeThenEnter({
        text: "[Promemoria] A",
        write: (data) => written.push(data),
        wait: async () => {
          target = asking
          await new Promise((resolve) => setTimeout(resolve, 5))
        },
        alive: () => true,
        permissionOpen: () => target.permissionPending,
      }),
    )
    const note = queue("p1", guarded("[Tempo] B"))
    // A's Enter would have answered the prompt (B1 bis): held back, the text left in the box.
    expect(await first).toBe("typed-no-enter")
    expect(await note).toBe("not-typed")
    expect(written).toEqual(["[Promemoria] A"])
  })
})

describe("the Enter is pressed only when no prompt is open at that moment (B1 bis)", () => {
  test("confirmSubmitted's second Enter: a prompt opened during the read is not answered", async () => {
    const written: string[] = []
    let prompt = false
    // confirmSubmitted's round: checked, then an await on the CLI's record, then the Enter.
    const round = async () => {
      if (prompt) return "stopped"
      await new Promise((resolve) => setTimeout(resolve, 5)).then(() => {
        prompt = true // the agent asked for a permission while its record was read
      })
      const check = "resend"
      if (check === "resend" && !pressEnter((data) => written.push(data), () => prompt)) return "held"
      return "resent"
    }
    expect(await round()).toBe("held")
    expect(written).toEqual([])
  })

  test("without a prompt the second Enter goes, as before", () => {
    const written: string[] = []
    expect(pressEnter((data) => written.push(data), () => false)).toBe(true)
    expect(written).toEqual(["\r"])
  })

  test("a line typed without its Enter counts as given: the next round does not type it again", async () => {
    const box: string[] = []
    const request: Pick<OpenRequest, "at" | "deliveredAt" | "budget" | "timeNotes"> = { at: 0, deliveredAt: 0, budget: 120 }
    let prompt = false
    // The workbench's round: counted when queued, given back only if the line was not given.
    const round = async (now: number) => {
      const due = timeNoteFor(request, now, { typing: false, permissionPending: prompt })
      if (!due) return
      const before = request.timeNotes
      request.timeNotes = due
      const outcome = await typeThenEnter({
        text: `[Tempo] ${due}`,
        write: (data) => box.push(data),
        wait: async () => {
          prompt = true // a prompt opens between the text and its Enter
        },
        alive: () => true,
        permissionOpen: () => prompt,
      })
      if (!lineGiven(outcome)) request.timeNotes = before
    }
    await round(61_000)
    expect(box).toEqual(["[Tempo] 1"])
    // The prompt is answered; the note is still in the box, and it is not typed a second time.
    prompt = false
    await round(62_000)
    await round(63_000)
    expect(box).toEqual(["[Tempo] 1"])
    expect(request.timeNotes).toBe(1)
  })
})
