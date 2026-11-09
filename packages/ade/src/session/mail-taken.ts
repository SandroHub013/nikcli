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
  }
}
