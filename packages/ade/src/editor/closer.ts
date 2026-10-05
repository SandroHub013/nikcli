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
  /** The agent alive in the pane, by name, when there is one. */
  readonly running?: (id: string) => string | undefined
  /** The user's answer: true ends the agent. */
  readonly askRunning?: (agent: string) => Promise<boolean>
  /** The session works in a worktree of its own (`session/worktree-close.ts`). */
  readonly hasWorktree?: (id: string) => boolean
  /** Why that worktree holds work that closing would strand (changes, or commits not yet integrated), or nothing. */
  readonly worktreeWork?: (id: string) => Promise<string | undefined>
  /** The user's answer: true closes the session anyway, and the folder stays on disk with its branch. */
  readonly askWorktree?: (reason: string) => Promise<boolean>
  /**
   * A close asked again while its question is open: the question is not asked a second time,
   * and the user is shown the one that waits (the window comes back from the icon).
   */
  readonly remind?: () => void
}

/**
 * How a close was asked for. `confirmRunning`: by the user's shortcut or the
 * palette, where one key ended the agent at work with nothing to take it back
 * (review of the frontend, ALTO 6). `ade-msg close` and the pane's own ✕ are
 * a decision already.
 *
 * `decided`: the close was already weighed against the work in the session's
 * worktree (`ade-msg close` refuses when there is some, unless forced), so it
 * is not asked again.
 */
export interface CloseHow {
  readonly confirmRunning?: boolean
  readonly decided?: boolean
}

export interface Closer {
  /** True when the pane is closed now; false when it waits on the user's answer. */
  readonly close: (id: string, how?: CloseHow) => boolean
  /** Settles once the pane is closed (true) or kept (false). */
  readonly closeAsking: (id: string, how?: CloseHow) => Promise<boolean>
  /**
   * Closes each in turn, asking about one unsaved file at a time.
   *
   * `how` reaches every one of them: closing a whole project used to pass the
   * ids alone, so an agent at work went with no question at all, where the
   * same close from the shortcut or the palette asks first (review
   * sidebar-clic, ALTO 1).
   */
  readonly closeAll: (ids: readonly string[], how?: CloseHow) => Promise<void>
}

export function createCloser(deps: CloserDeps): Closer {
  const asking = new Map<string, Promise<boolean>>()

  /** The question a close must ask first, or undefined: an unsaved file before a running agent. */
  const question = (id: string, how?: CloseHow): (() => Promise<boolean>) | undefined => {
    const path = deps.unsaved(id)
    if (path !== undefined) return () => deps.ask(path)
    const agent = how?.confirmRunning ? deps.running?.(id) : undefined
    if (agent !== undefined && deps.askRunning) return () => deps.askRunning!(agent)
    // Work in the session's worktree is not lost by closing (the folder stays), but the user is told before it is left behind.
    if (!how?.decided && deps.hasWorktree?.(id) && deps.worktreeWork && deps.askWorktree)
      return async () => {
        const reason = await deps.worktreeWork!(id).catch(() => undefined)
        return reason === undefined ? true : deps.askWorktree!(reason)
      }
    return undefined
  }

  const closeAsking = (id: string, how?: CloseHow): Promise<boolean> => {
    const open = asking.get(id)
    if (open) {
      deps.remind?.()
      return open
    }
    const ask = question(id, how)
    if (ask === undefined) {
      deps.closeNow(id)
      return Promise.resolve(true)
    }
    const answer = ask()
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
    close: (id, how) => {
      if (!asking.has(id) && question(id, how) === undefined) {
        deps.closeNow(id)
        return true
      }
      void closeAsking(id, how)
      return false
    },
    closeAsking,
    closeAll: async (ids, how) => {
      for (const id of ids) if (deps.exists(id)) await closeAsking(id, how)
    },
  }
}
