/**
 * Messages waiting their turn.
 *
 * Sending while the agent is working does not fail and does not interrupt: the
 * server stores the prompt and delivers it when the turn ends. Nothing in the UI
 * said so, so the message simply vanished from the composer and reappeared
 * minutes later — indistinguishable from having lost it.
 *
 * The same store carries a second delivery mode the UI never offered. `steer`
 * hands the message to the agent *during* the current turn rather than after it,
 * which is what you want the moment you realise it is heading the wrong way.
 */

export type PendingDelivery = "steer" | "queue"

export type PendingEntry = {
  id: string
  delivery: PendingDelivery
  createdAt: number
  /** The prompt as the server stored it; only its text parts are shown. */
  data?: { parts?: ReadonlyArray<{ type?: string; text?: string }> }
}

/**
 * What to show for a queued message.
 *
 * Its parts are the same shape a prompt is sent as, so a message can carry file
 * mentions and images that have no text. Those are summarised rather than
 * dropped, because a row with no text at all reads as an empty queue entry.
 */
export function pendingSummary(entry: PendingEntry, max = 120): string {
  const parts = entry.data?.parts ?? []
  const text = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")

  if (text) return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text

  const others = parts.filter((part) => part.type && part.type !== "text").length
  if (others > 0) return `${others} attachment${others === 1 ? "" : "s"}`
  return "(empty)"
}

/**
 * The entries worth showing, oldest first.
 *
 * `steer` entries are excluded: they are delivered into the running turn within
 * moments, so listing them as "waiting" would be wrong by the time it rendered.
 */
export function queuedEntries(entries: readonly PendingEntry[]): PendingEntry[] {
  return entries.filter((entry) => entry.delivery === "queue").sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * The full text of a queued message, for putting back in the composer.
 *
 * Unlike `pendingSummary` this does not truncate and does not describe: the user
 * is getting their own words back to edit, so anything lost here is lost for
 * good. Attachments cannot come back — they are not carried in the row — so a
 * message that was only attachments returns nothing rather than a placeholder
 * the user would have to delete.
 */
export function pendingText(entry: PendingEntry): string {
  return (entry.data?.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!)
    .join("")
    .trim()
}
