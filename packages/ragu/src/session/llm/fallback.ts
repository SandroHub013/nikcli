import type { StreamEvent, StreamOutput } from "./types"

export async function* withStreamFallback(
  native: AsyncIterable<StreamEvent>,
  fallback: () => Promise<StreamOutput>,
  abort: AbortSignal,
  onFallback?: (reason: string) => void,
  /**
   * Whether to go to the fallback for this error. False when a retry of the caller follows (r1: transient errors, the rate-limit
   * budget): those come first, and the fallback is what is left once they are spent. Absent, every error goes to the fallback.
   */
  shouldFallback?: (error: unknown) => boolean | Promise<boolean>,
): AsyncGenerator<StreamEvent> {
  let committed = false
  const pending: StreamEvent[] = []
  try {
    for await (const event of native) {
      if (event.type === "error") throw event.error
      if (!committed && event.type !== "start" && event.type !== "start-step") {
        committed = true
        yield* pending
        pending.length = 0
      }
      if (committed) yield event
      else pending.push(event)
    }
    yield* pending
  } catch (error) {
    // Never replay model output or tool execution, and never retry cancellation.
    if (committed || abort.aborted || (error instanceof Error && error.name === "AbortError")) throw error
    if (shouldFallback && !(await shouldFallback(error))) throw error
    onFallback?.(error instanceof Error ? error.message : String(error))
    yield* (await fallback()).fullStream
  }
}
