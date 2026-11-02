/**
 * The mail round's look at the long messages left in the inboxes: which were read, which were lost, which ring again.
 *
 * Out of the workbench so that a test can go through the round itself: the list it keeps is what the seal of a pane's
 * new process starts from (`inboxNamesOf`, `resealUnread`).
 */
import { dropFrom } from "./mail-lanes"
import { inboxAction, type InboxEntry } from "./mailbox"

export interface InboxRound<Session> {
  /** False until what was saved has been read back. Until then no pane exists yet, and none can be called closed. */
  readonly restored: () => boolean
  readonly paneExists: (paneId: string) => boolean
  /** False for a request closed meanwhile: an answer would be refused, and acting on it costs tokens for nothing. */
  readonly stillWanted: (entry: InboxEntry) => boolean
  readonly session: (paneId: string) => Session | undefined
  readonly readState: (entry: InboxEntry) => Promise<"unread" | "read" | "lost">
  readonly free: (paneId: string) => Promise<boolean>
  readonly typing: (paneId: string) => boolean
  /** Gone before it was read: said as lost, so nobody believes it arrived. */
  readonly lost: (entry: InboxEntry) => Promise<void>
  /** Held back from a half-written line: the sender is told, once. */
  readonly held: (entry: InboxEntry) => void
  readonly ring: (entry: InboxEntry, session: Session) => void
  /** Rung enough and never read: the sender is told, once. */
  readonly unread: (entry: InboxEntry) => void
  readonly save: () => void
}

/** Rings again for unread inbox messages, and tells the sender of one never read. */
export async function followInboxRound<Session>(
  pending: InboxEntry[],
  round: InboxRound<Session>,
  now: number,
): Promise<void> {
  if (!round.restored() || pending.length === 0) return
  let changed = false
  for (const entry of [...pending]) {
    const session = round.session(entry.paneId)
    // Relaunching, restoring or suspended: what it has not read is for its next process, sealed for it from this list.
    if (!session && round.paneExists(entry.paneId)) continue
    const state = session ? await round.readState(entry) : "unread"
    if (state === "lost") {
      if (!dropFrom(pending, entry)) continue
      await round.lost(entry)
      changed = true
      continue
    }
    const read = state === "read"
    const free = session && !read ? await round.free(entry.paneId) : false
    const action = inboxAction(entry, { running: Boolean(session), free, read, typing: round.typing(entry.paneId) }, now)
    if (action === "wait") continue
    if (action === "tell") {
      entry.told = true
      round.held(entry)
      changed = true
      continue
    }
    const wanted = action === "done" || round.stillWanted(entry)
    if (action === "ring" && session && wanted) {
      entry.rings += 1
      entry.ringAt = now
      round.ring(entry, session)
    } else if (action === "warn" && wanted) {
      if (entry.warned || !pending.includes(entry)) continue
      entry.warned = true
      round.unread(entry)
    } else if (!dropFrom(pending, entry)) {
      continue
    }
    changed = true
  }
  if (changed) round.save()
}

/** A pane's new process has been rung for nothing yet: what it inherits unread starts its bells over. True if any did. */
export function rearmInbox(pending: readonly InboxEntry[], paneId: string): boolean {
  let changed = false
  for (const entry of pending) {
    if (entry.paneId !== paneId || (entry.rings === 0 && !entry.warned)) continue
    entry.rings = 0
    entry.warned = false
    changed = true
  }
  return changed
}

/** The messages left for a pane and not read yet, as ADE knows them. */
export function inboxNamesOf(pending: readonly InboxEntry[], paneId: string): string[] {
  return pending.filter((entry) => entry.paneId === paneId).map((entry) => entry.name)
}
