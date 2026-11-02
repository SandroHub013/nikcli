import type { SpawnedSession } from "../host/shell"

/** The longest a relaunch counts as under way: `LIST_MS` + `MINT_MS` and the git calls of a start, with room. */
export const RELAUNCH_MAX_MS = 3 * 60_000

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
  /** Per pane, each relaunch under way with the time it began (review B2, B3). */
  readonly #relaunches = new Map<string, Map<symbol, number>>()

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
    this.#relaunches.clear()
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
    this.#relaunches.delete(id)
  }

  /**
   * `ade-msg relaunch` takes the old process away before the new one exists.
   * In between the pane has no session, but it is not a closed pane: its open
   * requests stay open (live test 2026-11-02, F1: a request older than the
   * spawn grace was closed with «si è chiusa senza rispondere» and the child's
   * later reply refused). The mark is the token of this relaunch; `endRelaunch`
   * with it, once the start has finished either way, takes it off, and a start
   * that failed then reads as the closed pane it is.
   */
  beginRelaunch(id: string, now: number = Date.now()): symbol {
    const token = Symbol(id)
    const marks = this.#relaunches.get(id) ?? new Map<symbol, number>()
    marks.set(token, now)
    this.#relaunches.set(id, marks)
    return token
  }

  /** The relaunch `token` is over; any other relaunch of the same pane still under way keeps its own mark. */
  endRelaunch(id: string, token: symbol): void {
    const marks = this.#relaunches.get(id)
    if (!marks) return
    marks.delete(token)
    if (marks.size === 0) this.#relaunches.delete(id)
  }

  /**
   * Whether the pane is between its old process and its new one: a relaunch under way that began less than
   * `RELAUNCH_MAX_MS` ago. Nothing on a start's path has a time limit of its own, so the mark has one: past it the pane
   * is the closed pane it looks like, and its requests close with the truth (review B2).
   */
  relaunching(id: string, now: number = Date.now()): boolean {
    if (this.#ended) return false
    for (const began of this.#relaunches.get(id)?.values() ?? []) if (now - began < RELAUNCH_MAX_MS) return true
    return false
  }

  /** Whether `token` is still the pane's current start. */
  starting(id: string, token: symbol): boolean {
    return !this.#ended && this.#starts.get(id) === token
  }

  /**
   * The spawn of the start `token`, back from the host: kept as the pane's
   * session while that start is current, ended with its tree otherwise.
   * True when kept.
   *
   * `refused`: the host could not start it (binary not on PATH, key refused, ssh unreachable). `spawn` still hands
   * back a session object then, already dead, and its exit has been handled; keeping it would leave a pane marked
   * running with nothing behind it, with no «Riprova» and mail «sent» into nothing (audit SES-1).
   */
  adopt(id: string, token: symbol, session: SpawnedSession, refused = false): boolean {
    if (refused || !this.starting(id, token)) {
      // Only its own token: a newer start of the pane may be in flight (review N2).
      if (refused && this.starting(id, token)) this.#starts.delete(id)
      void session.kill({ tree: true })
      return false
    }
    this.#starts.delete(id)
    this.set(id, session)
    return true
  }
}
