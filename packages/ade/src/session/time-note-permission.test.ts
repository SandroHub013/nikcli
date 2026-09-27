import { describe, expect, test } from "bun:test"
import { createLineQueue } from "./line-queue"
import { isQuestionOpen, lineIsTaken, timeNoteFor, type OpenRequest } from "./mailbox"
import { enterAgain, lineGiven, pressEnter, ringAgain, typeThenEnter, type LineOutcome } from "./enter"
import { submitCheck } from "./typing"

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

/*
 * The tests above feed the paths a `permissionPending` boolean, which is what they
 * have always been given and the only thing they can act on. What none of them
 * could catch is the caller: every one of these paths was reached in the workbench
 * through `permissions()[paneId]` — the screen alone — so a prompt the screen had
 * not recognised arrived here as `false` and the Enter went. The hook's `permission`
 * had to reach all of them, and the way to show that is a hook permission with an
 * empty screen, which is the exact shape the screen reading misses.
 */
describe("a prompt only the hook knows about holds every Enter (P1)", () => {
  const now = Date.now()
  const hookSaysPermission = { state: "permission" as const, at: now }
  const screen = undefined
  // What the workbench asks, and what it used to ask.
  const asking = () => isQuestionOpen(screen, hookSaysPermission)
  const screenOnly = () => Boolean(screen)

  test("the nudge: the time note is not due, so nothing is typed at all", () => {
    // The regression, stated as an assertion: the old expression said no.
    expect(screenOnly()).toBe(false)
    expect(asking()).toBe(true)
    // `unlessBusy`'s check, in the line queue, at the moment of writing.
    expect(lineIsTaken({ typing: false, permissionPending: asking() })).toBe(true)
    const request: Pick<OpenRequest, "at" | "deliveredAt" | "budget" | "timeNotes"> = { at: 0, deliveredAt: 0, budget: 120 }
    expect(timeNoteFor(request, 61_000, { typing: false, permissionPending: asking() })).toBeUndefined()
    // A draft is not what is holding it, so the two are not confused.
    expect(lineIsTaken({ typing: true, permissionPending: asking() })).toBe(true)
  })

  test("a line of ADE's own: not typed, and no Enter over the prompt", async () => {
    const written: string[] = []
    const outcome = await typeThenEnter({
      text: "Esegui: ade-msg list",
      write: (data) => written.push(data),
      wait: async () => {},
      alive: () => true,
      permissionOpen: asking,
    })
    // Not even the text: the prompt's input box is not a place for a message.
    expect(outcome).toBe("not-typed")
    expect(written).toEqual([])
  })

  test("the re-ring: enterAgain counts it, presses nothing, and gives the ring back", async () => {
    const written: string[] = []
    const request = { rings: 0 }
    const queue = createLineQueue()
    // The workbench's re-ring, with the count put back when no Enter went.
    const pressed = await ringAgain(request, () =>
      enterAgain({
        queue,
        key: "p1",
        write: (data) => written.push(data),
        alive: () => true,
        typing: () => false,
        permissionOpen: asking,
      }),
    () => {},
    )
    expect(pressed).toBe(false)
    expect(written).toEqual([])
    // A skipped ring does not use one up, so the next round still rings.
    expect(request.rings).toBe(0)
    // The same path with the screen's own reading: the Enter goes, as it always did.
    expect(pressEnter((data) => written.push(data), () => false)).toBe(true)
    expect(written).toEqual(["\r"])
  })
})

describe("the Enter is pressed only when no prompt is open at that moment (B1 bis)", () => {
  /*
   * With the pieces confirmSubmitted runs, not a copy of them (review area 2):
   * `submitCheck` decides the resend from the CLI's record, and `enterAgain`
   * presses it. The check used to be the literal "resend", so a fault in
   * `submitCheck` left this test green.
   */
  test("confirmSubmitted's second Enter: a prompt opened during the read is not answered", async () => {
    const written: string[] = []
    let prompt = false
    const typedAt = 1_000
    const round = async () => {
      if (prompt) return "stopped"
      // The CLI's record, read while the agent asks for a permission: nothing since the line.
      const activity = await new Promise<{ state: "idle"; at: number }>((resolve) =>
        setTimeout(() => {
          prompt = true
          resolve({ state: "idle", at: typedAt - 1 })
        }, 5),
      )
      const check = submitCheck({ typedAt, activity, now: typedAt + 60_000, deadline: typedAt + 30_000 })
      if (check !== "resend") return check
      const pressed = await enterAgain({
        queue: createLineQueue(),
        key: "p1",
        write: (data) => written.push(data),
        alive: () => true,
        typing: () => false,
        permissionOpen: () => prompt,
      })
      return pressed ? "resent" : "held"
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
