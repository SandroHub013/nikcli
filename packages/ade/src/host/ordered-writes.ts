/**
 * One pane's input, sent one write at a time.
 *
 * Each `invoke` is a task of its own on a multi-thread runtime, so two in flight can reach the pane's queue in either
 * order: after a stall, an Enter could land before the text it ends (RS-6, SES-6). Waiting for each answer keeps the
 * order, and costs little, because the command only queues the bytes and answers at once. Writes stay separate rather
 * than joined: text and its Enter sent apart are what makes an agent's input box read them as a line and not a paste.
 *
 * Each write answers whether the pane took it. A write that fails is dropped and the next one still goes: a stuck queue
 * would lose every key after it. Whoever cannot afford to lose it, as a mail delivery cannot, looks at the answer.
 */
export function orderedWrites(send: (data: string) => Promise<unknown>): (data: string) => Promise<boolean> {
  const waiting: { data: string; answer: (taken: boolean) => void }[] = []
  let sending = false
  const next = () => {
    const write = waiting.shift()
    if (write === undefined) {
      sending = false
      return
    }
    sending = true
    void send(write.data)
      .then(
        () => true,
        () => false,
      )
      .then((taken) => {
        write.answer(taken)
        next()
      })
  }
  return (data) =>
    new Promise((answer) => {
      waiting.push({ data, answer })
      if (!sending) next()
    })
}

/**
 * A value where only the last one matters, the size of a pane, sent one at a time.
 *
 * Two resizes in flight are tasks of their own behind a lock that keeps no order, so the older could land last and leave
 * the pane with a size it no longer has (RS2-6). One goes at a time, and of those waiting only the newest: the stale sizes
 * in between are dropped, and the last always lands. A refused one still lets the next go.
 */
export function latestOnly<T>(send: (value: T) => Promise<unknown>): (value: T) => void {
  let sending = false
  let waiting: { value: T } | undefined
  const go = (value: T) => {
    sending = true
    void send(value)
      .catch(() => undefined)
      .then(() => {
        const next = waiting
        waiting = undefined
        if (next) go(next.value)
        else sending = false
      })
  }
  return (value) => {
    if (sending) waiting = { value }
    else go(value)
  }
}
