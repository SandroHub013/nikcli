/**
 * Which file the agent is working on right now.
 *
 * Watching an agent work means watching the transcript scroll past and then
 * opening, by hand, whatever it says it edited. Every other agent panel on the
 * market solves this the same way — Zed calls it following the agent — by
 * jumping the editor to the file the agent has in its hands.
 *
 * The rule is deliberately narrow. Only tools that are actually working on a
 * file count: reading one is browsing, and `grep` or `list` name a directory or
 * a pattern, not a place to put the cursor. A tool still running outranks one
 * that finished, because that is where the agent is now rather than where it was.
 */

/** The subset of a transcript part this needs — kept structural so tests need no SDK. */
export type FollowPart = {
  type: string
  tool?: string
  state?: { status?: string; input?: { filePath?: unknown } }
}

/**
 * Tools whose subject is one file the user would want in front of them.
 *
 * `read` is missing on purpose: an agent reads dozens of files while it orients
 * itself, and following each one turns the editor into a slideshow.
 */
const EDITING_TOOLS = new Set(["edit", "write", "patch", "multiedit"])

const FOLLOWABLE_STATUS = new Set(["running", "completed"])

function pathOf(part: FollowPart): string | undefined {
  if (part.type !== "tool") return undefined
  if (!part.tool || !EDITING_TOOLS.has(part.tool)) return undefined
  const status = part.state?.status
  if (!status || !FOLLOWABLE_STATUS.has(status)) return undefined
  const filePath = part.state?.input?.filePath
  if (typeof filePath !== "string" || filePath.length === 0) return undefined
  return filePath
}

/**
 * The file to show, or undefined when the agent is not editing one.
 *
 * `parts` is in transcript order, oldest first.
 */
export function followTarget(parts: readonly FollowPart[]): string | undefined {
  let running: string | undefined
  let finished: string | undefined
  for (const part of parts) {
    const path = pathOf(part)
    if (path === undefined) continue
    if (part.state?.status === "running") running = path
    else finished = path
  }
  // An edit in flight is where the agent is; a finished one is only where it
  // was, and is the answer only while nothing is in flight.
  return running ?? finished
}

/**
 * Whether following should move the editor.
 *
 * Off by default and never while the user is idle: a tab opening under the
 * cursor after the turn has ended is the editor taking over, not following.
 */
export function shouldFollow(input: {
  enabled: boolean
  busy: boolean
  target: string | undefined
  current: string | undefined
}): boolean {
  if (!input.enabled || !input.busy) return false
  if (!input.target) return false
  return input.target !== input.current
}
