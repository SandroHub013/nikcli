/**
 * A real throttled response, end to end, over the native route.
 *
 * Everything else in `llm-event-adapter.test.ts` builds errors by hand. That is
 * the right default for mapping tests and the wrong one here: the claim under
 * test is that a genuine `429` carrying `Retry-After` survives the native
 * runtime intact, and a hand-built fixture cannot fail if the runtime stops
 * populating those fields. So this file serves a real 429 and lets the runtime
 * retry it.
 *
 * What it pins, per `specs/effect-tui/11-provider-inference-streaming.md`
 * requirements 6 and 8:
 *
 *  - the failure classifies as `APIError`, not `UnknownError`;
 *  - `statusCode` is 429, so `SessionRetry` treats it as transient;
 *  - the `Retry-After` the provider sent is still readable at the delay
 *    boundary, so the backoff waits what the provider asked for;
 *  - the runtime's own internal retries are the ones that consume the header —
 *    the processor sees one failure, not a retry storm.
 */
import { describe, expect, it } from "bun:test"
import * as OpenAICompatibleChat from "@nikcli-ai/llm/protocols/openai-compatible-chat"
import { streamRequest } from "@nikcli-ai/llm/runtime"
import { MessageV2 } from "@/session/message-v2"
import { SessionRetry } from "@/session/retry"
import { toProcessorStream, nativeErrorToAPICallError } from "@/session/llm/llm-event-adapter"

/** The runtime retries twice before giving up, so a 429 lands three times. */
const RUNTIME_ATTEMPTS = 3

function nativeRequest(baseURL: string) {
  return {
    id: "req_retry_after",
    model: OpenAICompatibleChat.model({
      id: "retry-after-model",
      provider: "probe",
      baseURL,
      apiKey: "local-test-key",
    }),
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
  } as never
}

describe("native 429 with Retry-After", () => {
  it("keeps the status and the header through to the retry delay", async () => {
    let hits = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        hits++
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "1" },
        })
      },
    })

    try {
      const events = (async function* () {
        yield* streamRequest(nativeRequest(`${server.url.origin}/v1`))
      })()

      let failure: unknown
      try {
        for await (const _ of toProcessorStream(events)) {
          // A 429 before any content produces no processor events; anything
          // here means the failure path started emitting frames it should not.
        }
      } catch (error) {
        failure = error
      }

      expect(failure).toBeDefined()
      // The runtime consumed the header itself on its own retries; the
      // processor is handed the one failure, not three.
      expect(hits).toBe(RUNTIME_ATTEMPTS)

      const classified = MessageV2.fromError(failure, { providerID: "probe" })
      expect(classified.name).toBe("APIError")
      if (!MessageV2.APIError.isInstance(classified)) throw new Error("unreachable")

      // A transient status is what `SessionRetry.retryable` keys on; losing it
      // is what turned a throttled turn into an opaque failure.
      expect(classified.data.statusCode).toBe(429)
      // Exactly, not "some string": the session layer's vocabulary is what the
      // user reads, and passing the provider body through would relabel this as
      // "Provider Server Error" because the body has an `error` key.
      expect(SessionRetry.retryable(classified)).toBe("Rate Limited")

      // The header survives exactly as the provider sent it — no recomputed
      // millisecond snapshot, which would go stale and would turn `Retry-After: 0`
      // into a backoff-skipping truthy string.
      const headers = classified.data.responseHeaders as Record<string, string> | undefined
      expect(headers?.["retry-after"]).toBe("1")
      expect(headers?.["retry-after-ms"]).toBeUndefined()

      // And the delay boundary waits what the provider asked for rather than
      // falling back to its own exponential backoff. Jitter only applies without
      // headers, so this is an exact value, not a range.
      expect(SessionRetry.delay(1, new MessageV2.APIError(classified.data))).toBe(1000)
    } finally {
      server.stop(true)
    }
  })

  it("leaves a non-transient provider status non-retryable", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ error: { message: "bad request" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      },
    })

    try {
      const events = (async function* () {
        yield* streamRequest(nativeRequest(`${server.url.origin}/v1`))
      })()

      let failure: unknown
      try {
        for await (const _ of toProcessorStream(events)) {
          // nothing expected before the failure
        }
      } catch (error) {
        failure = error
      }

      const classified = MessageV2.fromError(failure, { providerID: "probe" })
      // A 400 must not be retried: the spec requires authentication, validation
      // and schema failures to stay terminal without user action.
      expect(classified.name).toBe("APIError")
      if (!MessageV2.APIError.isInstance(classified)) throw new Error("unreachable")
      expect(classified.data.statusCode).toBe(400)
      expect(SessionRetry.retryable(classified)).toBeUndefined()
    } finally {
      server.stop(true)
    }
  })

  it("maps a rate-limit reason that carries only a parsed retry delay", () => {
    // `RateLimitReason` has no `status` field, so without this case the one
    // reason most worth mapping would be the one that falls through and comes
    // back as the `UnknownError` this mapping exists to prevent.
    const mapped = nativeErrorToAPICallError({
      reason: { _tag: "RateLimit", message: "slow down", retryAfterMs: 750 },
      retryable: true,
    })
    expect(mapped).toBeDefined()
    // The session vocabulary wins over the transport text: that is what
    // `SessionRetry.retryable` matches and what the user reads.
    expect(mapped?.message).toBe("Rate Limited")
    expect(mapped?.isRetryable).toBe(true)
    // The parsed delay is still evidence that a response existed — it just is
    // not republished as a header, for the reasons in the mapping.
    expect(mapped?.responseHeaders).toBeUndefined()
  })

  it("refuses to map a transport reset, which never got an answer", () => {
    // The counter-case: a network reset carries a request-only context, and
    // mapping it would invent a 500 for a request the provider never saw.
    expect(
      nativeErrorToAPICallError({
        reason: {
          _tag: "Transport",
          message: "socket hang up",
          kind: "reset",
          http: {
            request: { method: "POST", url: "https://api.test", headers: {} },
          },
        },
      }),
    ).toBeUndefined()
    expect(nativeErrorToAPICallError(new Error("plain"))).toBeUndefined()
  })
})
