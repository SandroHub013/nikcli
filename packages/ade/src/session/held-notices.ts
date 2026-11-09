/**
 * ADE's own notices to a session, while they wait for it to be free.
 *
 * They wait as mail does, behind the same test of the screen. On a pane whose box ADE cannot read that is for good: a
 * notice is no message of anyone's, so «Consegna ora» is not for it (`deliver-now.ts`). They piled up, and when the box
 * came back each one arrived alone, a turn the session pays for each. So they go as one line, and past half an hour they
 * are dropped, with a note to the user.
 */

export const NOTICE_TTL_MS = 30 * 60_000

interface HeldLine {
  paneId: string
  text: string
  notice?: true
  at?: number
}

const PREFIX = "[ade-msg] "
const SEPARATOR = " | "

/** The notices past their time, by pane. Mail is never among them. */
export function expiredNotices<T extends HeldLine>(held: readonly T[], now: number): Map<string, T[]> {
  const expired = new Map<string, T[]>()
  for (const item of held) {
    if (!item.notice || item.at === undefined || now - item.at < NOTICE_TTL_MS) continue
    expired.set(item.paneId, [...(expired.get(item.paneId) ?? []), item])
  }
  return expired
}

/** Every notice held for `paneId`, oldest first. */
export function gatherNotices<T extends HeldLine>(held: readonly T[], paneId: string): T[] {
  return held.filter((item) => item.notice && item.paneId === paneId).sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
}

/** One notice as it is; several as one line, because a newline typed in a box is an Enter. */
export function joinNotices(texts: readonly string[]): string {
  if (texts.length === 1) return texts[0]!
  const bare = texts.map((text) => (text.startsWith(PREFIX) ? text.slice(PREFIX.length) : text).replace(/\s*\n\s*/g, " "))
  return `${PREFIX}${texts.length} avvisi di ADE: ${bare.join(SEPARATOR)}`
}
