/**
 * One pane's input, sent one write at a time.
 *
 * Each `invoke` is a task of its own on a multi-thread runtime, so two in flight can reach the pane's queue in either
 * order: after a stall, an Enter could land before the text it ends (RS-6, SES-6). Waiting for each answer keeps the
 * order, and costs little, because the command only queues the bytes and answers at once. Writes stay separate rather
 * than joined: text and its Enter sent apart are what makes an agent's input box read them as a line and not a paste.
 *
 * A write that fails is dropped and the next one still goes: nothing here can tell the pane about it, and a stuck
 * queue would lose every key after it.
 */
export function orderedWrites(send: (data: string) => Promise<unknown>): (data: string) => void {
  const waiting: string[] = []
  let sending = false
  const next = () => {
    const data = waiting.shift()
    if (data === undefined) {
      sending = false
      return
    }
    sending = true
    void send(data).catch(() => undefined).then(next)
  }
  return (data) => {
    waiting.push(data)
    if (!sending) next()
  }
}
