/*
 * Closing panes when one may hold an unsaved file (F-confirm).
 *
 * The question is the dialog plugin's, answered later, so a close is not
 * always done when it returns. `close` says whether it was: `ade-msg close`
 * reported a pane as closed while the question was open, or after a no
 * (review F-confirm, BASSO 1). `closeAll` asks one file at a time: «chiudi i
 * pannelli spariti» opened every question at once (BASSO 2).
 */

export interface CloserDeps {
  /** The unsaved file's path, when the pane holds one. */
  readonly unsaved: (id: string) => string | undefined
  /** The user's answer: true discards the unsaved changes. */
  readonly ask: (path: string) => Promise<boolean>
  readonly closeNow: (id: string) => void
  /** Whether the pane is still there when the answer comes. */
  readonly exists: (id: string) => boolean
}

export interface Closer {
  /** True when the pane is closed now; false when it waits on the user's answer. */
  readonly close: (id: string) => boolean
  /** Settles once the pane is closed (true) or kept (false). */
  readonly closeAsking: (id: string) => Promise<boolean>
  /** Closes each in turn, asking about one unsaved file at a time. */
  readonly closeAll: (ids: readonly string[]) => Promise<void>
}

export function createCloser(deps: CloserDeps): Closer {
  const asking = new Map<string, Promise<boolean>>()

  const closeAsking = (id: string): Promise<boolean> => {
    const open = asking.get(id)
    if (open) return open
    const path = deps.unsaved(id)
    if (path === undefined) {
      deps.closeNow(id)
      return Promise.resolve(true)
    }
    const answer = deps
      .ask(path)
      .catch(() => false)
      .then((discard) => {
        if (!discard || !deps.exists(id)) return false
        deps.closeNow(id)
        return true
      })
      .finally(() => asking.delete(id))
    asking.set(id, answer)
    return answer
  }

  return {
    close: (id) => {
      if (!asking.has(id) && deps.unsaved(id) === undefined) {
        deps.closeNow(id)
        return true
      }
      void closeAsking(id)
      return false
    },
    closeAsking,
    closeAll: async (ids) => {
      for (const id of ids) if (deps.exists(id)) await closeAsking(id)
    },
  }
}
