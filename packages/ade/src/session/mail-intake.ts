/**
 * Taking mail out of `outbox/` without losing it.
 *
 * `mailboxTake` deletes the files at once, so from that moment the only copy of
 * a message is the one in `mailQueue`. That queue used to reach localStorage at
 * the end of the pass, after the deliveries (some of which wait seconds for a
 * session to close or start). A crash, a reload or the installer's kill in
 * between lost every `send` taken in that pass, whose senders had already been
 * told «in coda» and had exited 0.
 *
 * The queue is written down right after the taking and before anything is
 * awaited.
 */

export interface TakenMail {
  id: string
  body: string
}

export interface IntakeDeps {
  /** Takes the files out of the outbox (deleting them there). */
  take: () => Promise<TakenMail[]>
  /** Queues a valid message; `false` for one that is not valid. Synchronous on purpose. */
  accept: (id: string, body: string) => boolean
  /** Writes the queue down. */
  persist: () => void
  /** Tells the sender its message was refused. */
  refuse: (id: string) => Promise<unknown>
}

/** Takes, queues, writes down, and only then answers the refused ones. Returns how many were taken. */
export async function intakeMail(deps: IntakeDeps): Promise<number> {
  const taken = await deps.take().catch((): TakenMail[] => [])
  const refused: string[] = []
  for (const { id, body } of taken) if (!deps.accept(id, body)) refused.push(id)
  if (taken.length > 0) deps.persist()
  for (const id of refused) await deps.refuse(id).catch(() => {})
  return taken.length
}
