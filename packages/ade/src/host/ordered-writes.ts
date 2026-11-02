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
