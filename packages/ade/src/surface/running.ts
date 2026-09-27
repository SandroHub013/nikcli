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
 * per update, a 580 MB nikcli among them, alive until ADE closed.
 *
 * `endAll` is the surface's half of what a reload does. A spawn that comes
 * back after it — a restore still awaiting `host.spawn` when the surface went
 * — is ended as it arrives instead of being held by a surface that is gone.
 */
export class RunningSessions extends Map<string, SpawnedSession> {
  #ended = false

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
    const sessions = [...this.values()]
    this.clear()
    for (const session of sessions) void session.kill({ tree: true })
    return sessions.length
  }
}
