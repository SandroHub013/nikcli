/**
 * A first draft of the commit message.
 *
 * The field was empty, and an empty field on a form you reach after reviewing a
 * diff is a small tax paid every time. Zed generates one with a model; that is a
 * request and a wait for something the session already knows — its title is a
 * summary of this exact unit of work, written when the conversation started
 * making sense.
 *
 * A draft, not an answer: it lands in an editable field, and a title that reads
 * badly as a commit subject is one keystroke from being replaced.
 */

/** Git's own soft limit, and what every log viewer truncates at. */
export const SUBJECT_LIMIT = 72

export function commitSubject(title: string | undefined): string {
  if (!title) return ""

  // Only the first line: a title is one, but nothing guarantees it.
  const first = title.split("\n")[0]!.trim().replace(/\s+/g, " ")
  if (!first) return ""

  // Trailing punctuation is noise in a subject line, and git's own convention
  // is to leave the full stop off.
  const trimmed = first.replace(/[.…]+$/, "").trim()
  if (trimmed.length <= SUBJECT_LIMIT) return trimmed

  // Cut on a word boundary rather than mid-word, but only if that leaves
  // something worth reading — a single very long word is truncated as it is.
  const cut = trimmed.slice(0, SUBJECT_LIMIT)
  const lastSpace = cut.lastIndexOf(" ")
  return lastSpace > SUBJECT_LIMIT / 2 ? cut.slice(0, lastSpace) : cut
}
