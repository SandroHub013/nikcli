/**
 * When to say that xterm threw a pane's output away: not for every chunk of a burst, and not only the first time ever.
 * Output lost without a word is the one thing a terminal must not do, so a new program in the pane and a window that has
 * come back each start the count again.
 */
export interface DiscardNotes {
  /** xterm has refused a chunk of this pane. */
  refused(paneId: string): void
  /** A new program has started in this pane. */
  started(paneId: string): void
  dispose(): void
}

type Visibility = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">

export function createDiscardNotes(say: (paneId: string) => void, doc: Visibility = document): DiscardNotes {
  const noted = new Set<string>()
  const onVisibility = () => {
    if (doc.visibilityState === "visible") noted.clear()
  }
  doc.addEventListener("visibilitychange", onVisibility)
  return {
    refused(paneId) {
      if (noted.has(paneId)) return
      noted.add(paneId)
      say(paneId)
    },
    started(paneId) {
      noted.delete(paneId)
    },
    dispose() {
      doc.removeEventListener("visibilitychange", onVisibility)
    },
  }
}
