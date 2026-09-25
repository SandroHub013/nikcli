/**
 * Sending what is in a bot's composer.
 *
 * The composer is cleared at once, so a message is not sent twice by a
 * second Enter while the first is on its way. What did not go comes back:
 * a trust question already open, a «no» to it, a bot that refuses to start
 * or a turn still running (B3-bis, review B3, BASSO 3) — unless something
 * new was typed meanwhile, which is not overwritten.
 */
export async function submitDraft(
  text: string,
  send: (text: string) => boolean | Promise<boolean>,
  draft: { get: () => string; set: (text: string) => void },
): Promise<void> {
  draft.set("")
  let sent = false
  try {
    sent = await send(text)
  } catch {
    sent = false
  }
  if (!sent && draft.get().trim().length === 0) draft.set(text)
}
