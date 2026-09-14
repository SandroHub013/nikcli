/**
 * How much of a turn the transcript shows.
 *
 * One session at a time can afford to render every reasoning block and every
 * tool call. Scanning several — which is the point of running agents in
 * parallel — cannot: the answer is buried under the work that produced it.
 *
 * `normal` is what the app has always shown. `verbose` keeps the reasoning that
 * `normal` drops once a turn finishes. `compact` keeps only what the agent
 * actually said, for reading a session back rather than watching it work.
 */
export type TranscriptVerbosity = "compact" | "normal" | "verbose"

export const TRANSCRIPT_VERBOSITY: readonly TranscriptVerbosity[] = ["compact", "normal", "verbose"]

export function isTranscriptVerbosity(value: unknown): value is TranscriptVerbosity {
  return typeof value === "string" && (TRANSCRIPT_VERBOSITY as readonly string[]).includes(value)
}

/** Cycles in increasing detail, wrapping back to the quietest. */
export function nextVerbosity(current: TranscriptVerbosity): TranscriptVerbosity {
  const index = TRANSCRIPT_VERBOSITY.indexOf(current)
  return TRANSCRIPT_VERBOSITY[(index + 1) % TRANSCRIPT_VERBOSITY.length]
}

/**
 * Reasoning is noise once a turn has finished, but it is the whole point while
 * the turn is running — so `normal` keeps it only while working, and `verbose`
 * keeps it always.
 */
export function shouldHideReasoning(input: { verbosity: TranscriptVerbosity; working: boolean }): boolean {
  if (input.verbosity === "verbose") return false
  if (input.verbosity === "compact") return true
  return !input.working
}

/** Whether tool calls are drawn at all. Only `compact` drops them. */
export function shouldHideToolCalls(verbosity: TranscriptVerbosity): boolean {
  return verbosity === "compact"
}
