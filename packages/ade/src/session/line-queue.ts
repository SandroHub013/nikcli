/**
 * One line at a time per session.
 *
 * Typing a line is two writes with a wait between them: the text, then, once
 * the program has taken it in (up to 2.5 s), the Enter. Two lines started at
 * once on the same session put both texts in the input before either Enter,
 * and the first Enter sent them glued together: live, a time note and a
 * reminder due in the same round arrived as «[Tempo] …[Promemoria] …», and
 * lines held back by a draft all left together once it was emptied, one send
 * and two empty Enters.
 *
 * So each session has a chain: a line starts when the one before it has had
 * its Enter. A line that fails does not stop the ones behind it.
 */
export type LineQueue = <T>(key: string, job: () => Promise<T>) => Promise<T>

export function createLineQueue(): LineQueue {
  const tails = new Map<string, Promise<unknown>>()
  return <T>(key: string, job: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve()
    const run = previous.then(job)
    // The chain goes on whatever this line did.
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return run
  }
}
