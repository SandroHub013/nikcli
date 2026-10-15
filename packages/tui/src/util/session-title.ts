import { SessionPrimitives } from "@ragu/util/session-primitives"

const two = (n: number) => String(n).padStart(2, "0")

/**
 * A session has no title until the model writes one, and until then it is called «New session - 2026-10-15T20:48:09.845Z»:
 * the raw ISO stamp, in UTC, wrapping in a narrow sidebar. Shown as «New session · 22:48» instead, in the user's own time.
 * Any other title is the user's or the model's, and is left as it is.
 */
export function sessionDisplayTitle(title: string): string {
  if (!SessionPrimitives.isDefaultTitle(title)) return title
  const child = title.startsWith(SessionPrimitives.childTitlePrefix)
  const prefix = child ? SessionPrimitives.childTitlePrefix : SessionPrimitives.parentTitlePrefix
  const at = new Date(title.slice(prefix.length))
  const label = child ? "Child session" : "New session"
  if (Number.isNaN(at.getTime())) return label
  return `${label} · ${two(at.getHours())}:${two(at.getMinutes())}`
}
