/**
 * The page's half of the PTY's flow control (audit 2026-11-02, RS-7).
 *
 * The host counts the bytes it has sent for a session and waits when too many are unanswered, so a page that cannot
 * keep up slows the child instead of growing without limit (`pty.rs`, `Flow`). Each chunk arrives with its size in
 * bytes; this says back, through `ack`, how many the terminal has written.
 *
 * `onData` decides when that is. A handler that only reads the chunk returns nothing, and the chunk counts as written
 * when it returns. A handler that feeds a terminal returns `true` and calls `written` from the terminal's own write
 * callback, because that is when xterm has parsed it: acknowledging at the event would only measure the script queue,
 * not xterm's write buffer, which silently drops what passes its own limit.
 *
 * A handler that throws still pays the chunk: the host must never wait for bytes nobody will answer for.
 */
export function deliverChunk(
  payload: { data: string; bytes?: number },
  onData: ((chunk: string, written: () => void) => boolean | void) | undefined,
  ack: (bytes: number) => void,
): void {
  const bytes = payload.bytes ?? 0
  let paid = false
  const written = () => {
    if (paid) return
    paid = true
    if (bytes > 0) ack(bytes)
  }
  if (!onData) return written()
  let deferred = false
  try {
    deferred = onData(payload.data, written) === true
  } catch (error) {
    written()
    throw error
  }
  if (!deferred) written()
}

/** Acknowledgements are sent in batches of at least this many bytes: half of the host's 512 KiB high water mark. */
export const ACK_BATCH_BYTES = 256 * 1024

/** Adds up what the terminal has written and calls `send` once there is a batch of it. */
export function createAckBatcher(send: (bytes: number) => void, batch = ACK_BATCH_BYTES): (bytes: number) => void {
  let owed = 0
  return (bytes) => {
    owed += bytes
    if (owed < batch) return
    const now = owed
    owed = 0
    send(now)
  }
}
