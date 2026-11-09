/**
 * ADE's own notices to a session, while they wait for it to be free.
 *
 * They wait as mail does, behind the same test of the screen. On a pane whose box ADE cannot read that is for good: a
 * notice is no message of anyone's, so «Consegna ora» is not for it (`deliver-now.ts`). They piled up, and when the box
 * came back each one arrived alone, a turn the session pays for each. So they go as one line, the newest of them.
 *
 * Past half an hour they are dropped, with a note to the user, but only on a box ADE cannot read: that wait has no end of
 * its own, while a turn or a menu does, and a turn of 40 minutes is ordinary. An error is never dropped: it says a message
 * did not arrive, and without it the session goes on believing it did.
 *
 * Joined, they can overtake mail queued before them for the same pane: a round gathers them at the first notice it meets.
 */

export const NOTICE_TTL_MS = 30 * 60_000
/** How many notices one line carries, errors first. */
export const MOST_JOINED = 8

interface HeldLine {
  paneId: string
  text: string
  notice?: true
  at?: number
}

const PREFIX = "[ade-msg] "
const SEPARATOR = " | "
const isError = (text: string) => text.startsWith(`${PREFIX}errore:`)

/** The notices past their time on a pane `blind` says ADE cannot read, by pane. Neither mail nor an error is ever among them. */
export function expiredNotices<T extends HeldLine>(
  held: readonly T[],
  now: number,
  blind: (paneId: string) => boolean,
): Map<string, T[]> {
  const expired = new Map<string, T[]>()
  for (const item of held) {
    if (!item.notice || item.at === undefined || now - item.at < NOTICE_TTL_MS) continue
    if (isError(item.text) || !blind(item.paneId)) continue
    expired.set(item.paneId, [...(expired.get(item.paneId) ?? []), item])
  }
  return expired
}

/** Every notice held for `paneId`, oldest first. */
export function gatherNotices<T extends HeldLine>(held: readonly T[], paneId: string): T[] {
  return held.filter((item) => item.notice && item.paneId === paneId).sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
}

/**
 * One notice as it is; several as one line, because a newline typed in a box is an Enter. Every error goes in, and the newest
 * of the others up to `MOST_JOINED`: thirty notices were 7.5k typed in one go.
 */
export function joinNotices(texts: readonly string[]): string {
  if (texts.length === 1) return texts[0]!
  let room = Math.max(0, MOST_JOINED - texts.filter(isError).length)
  const kept = [...texts].reverse().filter((text) => isError(text) || room-- > 0).reverse()
  const bare = kept.map((text) => (text.startsWith(PREFIX) ? text.slice(PREFIX.length) : text).replace(/\s*\n\s*/g, " "))
  const left = texts.length - kept.length
  return `${PREFIX}${texts.length} avvisi di ADE: ${[...bare, ...(left > 0 ? [`e altri ${left} più vecchi`] : [])].join(SEPARATOR)}`
}
