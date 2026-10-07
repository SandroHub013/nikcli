import { describe, expect, it } from "bun:test"
import { withStreamFallback } from "@/session/llm/fallback"
import { streamResult } from "@/session/llm/llm-event-adapter"
import type { StreamEvent } from "@/session/llm/types"
import { SessionRetry } from "@/session/retry"

/**
 * v1.431 brings the AI SDK back as the fallback runtime. A native stream that fails before any output used to go straight to it, ahead
 * of the processor's own retries (r1: transient errors, rate-limit budget). The order we want for an error before the output is:
 * the retries first, then the fallback, with a line in the log that says why and after how many attempts.
 */

const failing = (error: Error) =>
  (async function* (): AsyncGenerator<StreamEvent> {
    yield { type: "start" }
    yield { type: "start-step" }
    throw error
  })()

const legacy = (calls: { n: number }) => async () => {
  calls.n++
  return streamResult(
    (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "start" }
      yield { type: "text-delta", id: "sdk", text: "ok" }
    })(),
  )
}

const drain = async (stream: AsyncIterable<StreamEvent>) => {
  const seen: StreamEvent[] = []
  for await (const event of stream) seen.push(event)
  return seen
}

describe("an error before the output: the retries come before the fallback", () => {
  it("when a retry follows, the error is rethrown and the fallback is not used", async () => {
    const calls = { n: 0 }
    const failure = new Error("503 overloaded")
    await expect(
      drain(withStreamFallback(failing(failure), legacy(calls), new AbortController().signal, undefined, async () => false)),
    ).rejects.toBe(failure)
    expect(calls.n).toBe(0)
  })

  it("when no retry follows (spent, or not retryable), the fallback runs and says why", async () => {
    const calls = { n: 0 }
    const reasons: string[] = []
    const seen = await drain(
      withStreamFallback(
        failing(new Error("connection failed")),
        legacy(calls),
        new AbortController().signal,
        (reason) => void reasons.push(reason),
        async () => true,
      ),
    )
    expect(calls.n).toBe(1)
    expect(reasons).toEqual(["connection failed"])
    expect(seen.map((event) => event.type)).toEqual(["start", "text-delta"])
  })

  it("without a predicate it is what it was: the fallback runs", async () => {
    const calls = { n: 0 }
    await drain(withStreamFallback(failing(new Error("x")), legacy(calls), new AbortController().signal))
    expect(calls.n).toBe(1)
  })
})

describe("SessionRetry.retryFollows: the processor's decision, asked before the processor makes it", () => {
  const base = { retry: "Provider Server Error", rateLimited: false, attempt: 0, rateWaited: 0, rateDelay: 0, budget: 600_000, outputEmitted: false }

  it("a retryable error with attempts left is followed by a retry", () => {
    expect(SessionRetry.retryFollows(base)).toBe(true)
    expect(SessionRetry.retryFollows({ ...base, attempt: SessionRetry.RETRY_MAX_ATTEMPTS - 1 })).toBe(true)
  })

  it("not when the attempts are spent, the error is not retryable, or output was emitted", () => {
    expect(SessionRetry.retryFollows({ ...base, attempt: SessionRetry.RETRY_MAX_ATTEMPTS })).toBe(false)
    expect(SessionRetry.retryFollows({ ...base, retry: undefined })).toBe(false)
    expect(SessionRetry.retryFollows({ ...base, outputEmitted: true })).toBe(false)
  })

  it("a rate limit is counted in time waited: followed while the budget lasts, not after", () => {
    const limited = { ...base, retry: "Rate limited", rateLimited: true, rateDelay: 30_000 }
    expect(SessionRetry.retryFollows({ ...limited, rateWaited: 500_000 })).toBe(true)
    expect(SessionRetry.retryFollows({ ...limited, rateWaited: 580_000 })).toBe(false)
    // A zero wait still costs a second, as in the processor.
    expect(SessionRetry.retryFollows({ ...limited, rateDelay: 0, rateWaited: 599_500 })).toBe(false)
    // The attempts do not count for a rate limit.
    expect(SessionRetry.retryFollows({ ...limited, attempt: SessionRetry.RETRY_MAX_ATTEMPTS })).toBe(true)
  })
})
