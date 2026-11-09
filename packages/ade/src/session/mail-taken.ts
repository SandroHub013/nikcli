import { splitSealed } from "./mail-seal"

/**
 * Which messages this page has had from the outbox, so that none is carried out twice.
 *
 * The native side keeps a message until the page says it holds it, and gives it back when that word does not come: after
 * 30 s, or to the next page after a reload. So the same message can be handed over again, and the check against replays is
 * no help here: it runs only on a proven message, and it forgets at a reload. An id on its own is not enough to go by
 * either, since anybody can read one, so a copy is the same id with the same seal, or the same text where there is none.
 * What came back from the saved queue is a copy by its id: that message is already waiting here.
 */
export function createTakenMail(cap = 5000) {
  const handled = new Map<string, string>()
  const restored = new Set<string>()
  const mark = (body: string) => splitSealed(body)?.mac ?? body

  return {
    isCopy: (id: string, body: string): boolean => restored.has(id) || handled.get(id) === mark(body),
    handled(id: string, body: string): void {
      handled.set(id, mark(body))
      if (handled.size > cap) handled.delete(handled.keys().next().value!)
    },
    restored(id: string): void {
      restored.add(id)
    },
    /**
     * A take sorted: what is new here, and which copies have nothing left to do. A message that ended while it was back in
     * the outbox, or that was refused at first sight, had no claim to confirm then, and this is the next chance.
     */
    sort<T extends { id: string; body: string }>(taken: readonly T[], waiting: (id: string) => boolean) {
      const fresh: T[] = []
      const settled: string[] = []
      for (const item of taken) {
        if (this.isCopy(item.id, item.body)) {
          if (!waiting(item.id)) settled.push(item.id)
          continue
        }
        this.handled(item.id, item.body)
        fresh.push(item)
      }
      return { fresh, settled }
    },
  }
}

/** Whether this page still has the message to deliver: with storage refusing it exists only here, and its outbox copy must stay. */
export const waitingIn =
  (queue: readonly { id: string }[], held: readonly { inbox?: { id: string } }[]) =>
  (id: string): boolean =>
    queue.some((item) => item.id === id) || held.some((line) => line.inbox?.id === id)

/** Whether a message whose delivery has ended can leave the outbox: it is saved, or there is nothing of it left to lose. */
export const mayConfirmEnded = (saved: boolean, waiting: boolean): boolean => saved || !waiting

/** What a take confirms: all it was handed once that is saved, otherwise only the copies with nothing left to do. */
export const idsToConfirm = (saved: boolean, taken: readonly { id: string }[], settled: readonly string[]): string[] =>
  saved ? taken.map(({ id }) => id) : [...settled]
