import type { SpawnedSession } from "../host/shell"

/**
 * The processes behind the panes, owned by the surface that started them.
 *
 * A page that goes away takes its sessions with it: the desktop shell ends
 * every pty when a new document loads (`pty::Registry::end_all`). The surface
 * can also go away without the page. Vite's hot update of `workbench.tsx`
 * disposes the Workbench and mounts a new one in the same document, and the
 * new one restores every pane by spawning again, so each save left a whole
 * set of agents running with no pane to reach them: measured, three agents
 * per update, a 580 MB ragu among them, alive until ADE closed.
 *
 * `endAll` is the surface's half of what a reload does. A spawn that comes
 * back after it — a restore still awaiting `host.spawn` when the surface went
 * — is ended as it arrives instead of being held by a surface that is gone.
 *
 * The same goes for one pane (audit SES-2). A start awaits git, the keys and
 * the spawn before the session is in the map, so a pane closed meanwhile had
 * nothing to kill: the process came up with no pane, out of `ade-msg list`,
 * and was typed its opening task. Each start holds a token (`beginStart`);
 * closing the pane, or starting it again, takes the token away, and the spawn
 * that comes back without it is ended with its tree (`adopt`).
 */
export class RunningSessions extends Map<string, SpawnedSession> {
  #ended = false
  readonly #starts = new Map<string, symbol>()

  override set(id: string, session: SpawnedSession): this {
    if (this.#ended) {
      void session.kill({ tree: true })
      return this
    }
    return super.set(id, session)
  }

  /** Ends every session, with the processes each one started, as a reload does. */
  endAll(): number {
    this.#ended = true
    this.#starts.clear()
    const sessions = [...this.values()]
    this.clear()
    for (const session of sessions) void session.kill({ tree: true })
    return sessions.length
  }

  /** A start of the pane begins: any start still in flight for it is superseded. */
  beginStart(id: string): symbol {
    const token = Symbol(id)
    this.#starts.set(id, token)
    return token
  }

  /** The pane is closing: the start in flight, if any, must not adopt its process. */
  cancelStart(id: string): void {
    this.#starts.delete(id)
  }

  /** Whether `token` is still the pane's current start. */
  starting(id: string, token: symbol): boolean {
    return !this.#ended && this.#starts.get(id) === token
  }

  /**
   * The spawn of the start `token`, back from the host: kept as the pane's
   * session while that start is current, ended with its tree otherwise.
   * True when kept.
   */
  adopt(id: string, token: symbol, session: SpawnedSession): boolean {
    if (!this.starting(id, token)) {
      void session.kill({ tree: true })
      return false
    }
    this.#starts.delete(id)
    this.set(id, session)
    return true
  }
}
