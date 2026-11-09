import { describe, expect, test } from "bun:test"
import { createChangeWriter } from "./change-writer"
import { createTakenMail, idsToConfirm, mayConfirmEnded, waitingIn } from "./mail-taken"

/*
 * RS2-5 B: the native side keeps a message until the page says it has it, and gives it back if the word does not come. So
 * the page can be handed the same message twice, and the agent must not be.
 */
const sealed = (mac: string, body: string) => `ade-mac1 ${mac.repeat(64)}\n${body}`

describe("a message given back is not carried out twice", () => {
  const round = (taken: ReturnType<typeof createTakenMail>, queue: string[], id: string, body: string) => {
    if (taken.isCopy(id, body)) return
    taken.handled(id, body)
    queue.push(id)
  }

  test("handed again by a take after its 30 s: one delivery", () => {
    const taken = createTakenMail()
    const queue: string[] = []
    round(taken, queue, "m1", "{}")
    round(taken, queue, "m1", "{}")
    round(taken, queue, "m1", "{}")
    expect(queue).toEqual(["m1"])
  })

  test("given back to a page that read it from its saved queue: not carried out again, whatever the seal says", () => {
    const taken = createTakenMail()
    const queue: string[] = []
    taken.restored("m2")
    round(taken, queue, "m2", "{}")
    expect(queue).toEqual([])
  })

  test("another file under the same id is not the same message", () => {
    const taken = createTakenMail()
    const queue: string[] = []
    round(taken, queue, "m3", "uno")
    round(taken, queue, "m3", "due")
    expect(queue).toEqual(["m3", "m3"])
  })

  test("two messages are two messages", () => {
    const taken = createTakenMail()
    const queue: string[] = []
    round(taken, queue, "m4", "{}")
    round(taken, queue, "m5", "{}")
    expect(queue).toEqual(["m4", "m5"])
  })

  test("the memory is bounded, oldest first", () => {
    const taken = createTakenMail(2)
    taken.handled("a", "x")
    taken.handled("b", "x")
    taken.handled("c", "x")
    expect(taken.isCopy("a", "x")).toBe(false)
    expect(taken.isCopy("c", "x")).toBe(true)
  })

  test("a sealed copy is told by its seal, so the body need not be kept", () => {
    const taken = createTakenMail()
    taken.handled("m6", sealed("a", '{"kind":"send"}'))
    expect(taken.isCopy("m6", sealed("a", '{"kind":"send"}'))).toBe(true)
    expect(taken.isCopy("m6", sealed("b", '{"kind":"send"}'))).toBe(false)
  })
})

/** What the native side does with its claims (`take_outbox`, `confirm_taken`, `give_back_all`). */
function nativeClaims() {
  const files = new Map<string, { body: string; handed: boolean }>()
  return {
    post: (id: string, body: string) => void files.set(id, { body, handed: false }),
    take() {
      const out: { id: string; body: string }[] = []
      for (const [id, file] of files) {
        if (file.handed) continue
        file.handed = true
        out.push({ id, body: file.body })
      }
      return out
    },
    /** The 30 s are over, or the page has gone: what was handed and not confirmed is back in the outbox. */
    giveBack: () => files.forEach((file) => (file.handed = false)),
    /** A confirm counts only for what is handed out now: on a message back in the outbox it finds no claim. */
    confirm(ids: string[]) {
      for (const id of ids) if (files.get(id)?.handed) files.delete(id)
    },
    has: (id: string) => files.has(id),
  }
}

/** The page's real decisions, on a queue and held lines of its own and a storage that may refuse every write. */
function pageOn(native: ReturnType<typeof nativeClaims>, storage = { works: false }) {
  const writer = createChangeWriter(() => {})
  const ledger = createTakenMail()
  const queue: { id: string }[] = []
  const held: { inbox: { id: string } }[] = []
  const waiting = waitingIn(queue, held)
  const saved = () => writer.save(JSON.stringify([queue, held]), () => storage.works)
  const out = <T extends object>(list: T[], at: (item: T) => boolean) => void list.splice(list.findIndex(at), 1)
  const ended = (id: string) => {
    if (mayConfirmEnded(saved(), waiting(id))) native.confirm([id])
  }
  return {
    /** A take, as `takeMail` does it: the ids that are new here. */
    take() {
      const handed = native.take()
      const { fresh, settled } = ledger.sort(handed, waiting)
      queue.push(...fresh)
      native.confirm(idsToConfirm(saved(), handed, settled))
      return fresh.map(({ id }) => id)
    },
    typed(id: string) {
      out(queue, (item) => item.id === id)
      ended(id)
    },
    heldForSuspended(id: string) {
      out(queue, (item) => item.id === id)
      held.push({ inbox: { id } })
      ended(id)
    },
    heldTyped: (id: string) => out(held, (line) => line.inbox.id === id),
    refused: (id: string) => out(queue, (item) => item.id === id),
  }
}

describe("storage refusing every write: nothing lost, nothing typed twice", () => {
  const id = "m1"
  const posted = () => {
    const native = nativeClaims()
    native.post(id, "{}")
    return native
  }

  test("with storage working, a take confirms at once", () => {
    const native = posted()
    expect(pageOn(native, { works: true }).take()).toEqual([id])
    expect(native.has(id)).toBe(false)
  })

  test("a line held for a suspended session keeps its outbox copy, and a reload gets it back", () => {
    const native = posted()
    const page = pageOn(native)
    page.take()
    page.heldForSuspended(id)
    expect(native.has(id)).toBe(true)
    native.giveBack()
    expect(pageOn(native).take()).toEqual([id])
  })

  test("once the held line has been typed, the next hand-out lets the copy go", () => {
    const native = posted()
    const page = pageOn(native)
    page.take()
    page.heldForSuspended(id)
    page.heldTyped(id)
    native.giveBack()
    expect(page.take()).toEqual([])
    expect(native.has(id)).toBe(false)
  })

  test("a confirm that found the message back in the outbox is made good at the next hand-out, so a reload does not type it again", () => {
    const native = posted()
    const page = pageOn(native)
    page.take()
    native.giveBack()
    page.typed(id)
    expect(native.has(id)).toBe(true)
    expect(page.take()).toEqual([])
    expect(native.has(id)).toBe(false)
    expect(pageOn(native).take()).toEqual([])
  })

  test("a message refused at first sight goes at its first copy: its error is not sent again after a reload", () => {
    const native = posted()
    const page = pageOn(native)
    page.take()
    page.refused(id)
    native.giveBack()
    expect(page.take()).toEqual([])
    expect(native.has(id)).toBe(false)
  })
})
