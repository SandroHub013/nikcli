/**
 * Whether the session route shows the home instead of an empty conversation.
 *
 * ADE starts ragu on a conversation it has just created (`--session <id>`), so
 * without this the home, with the wordmark, never appears there. Only a root
 * conversation whose messages are known to be none: one still loading may have
 * history, and a subagent's is never a place to start from. `started` is a
 * latch: a conversation that has had a message does not turn back into the
 * home when its messages go (a revert, a compaction).
 */
export function showsHome(input: {
  loaded: boolean
  root: boolean
  messages: number
  pending: number
  started: boolean
}): boolean {
  return input.loaded && input.root && !input.started && input.messages === 0 && input.pending === 0
}
