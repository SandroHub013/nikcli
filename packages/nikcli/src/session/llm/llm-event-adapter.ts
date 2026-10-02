import type { LLMEvent } from "@nikcli-ai/llm"
import { APICallError } from "@ai-sdk/provider"
import type { streamText } from "ai"
import { Log } from "@nikcli-ai/util/log"

type Result = Awaited<ReturnType<typeof streamText>>
export type ProcessorStreamEvent = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

const log = Log.create({ service: "llm-event-adapter" })

export function adapterState() {
  return {
    step: 0,
    text: 0,
    reasoning: 0,
    currentTextID: undefined as string | undefined,
    currentReasoningID: undefined as string | undefined,
    toolInputStarted: new Set<string>(),
    toolNames: {} as Record<string, string>,
    emittedStart: false,
    // A step is what the processor snapshots and bills against. No native
    // protocol emits step-start/step-finish — only request-start/request-finish
    // — so the adapter opens and closes the step itself, and these two guards
    // keep it from doubling up for a provider that emits both.
    stepOpen: false,
    stepFinished: false,
  }
}

type AdapterState = ReturnType<typeof adapterState>

function finishReason(value: string | undefined): string {
  const valid = ["stop", "length", "content-filter", "tool-calls", "end-turn"]
  return valid.includes(value ?? "") ? (value as string) : "unknown"
}

/**
 * Map native `provider-error` events to `APICallError` so
 * `MessageV2.fromError` classifies them as `APIError` with
 * `isRetryable` preserved. Plain `Error` collapses to `UnknownError`
 * and loses SessionRetry auto-retry for throttles/429s (F1.2).
 *
 * Defensive: the LLM event contract may evolve; we validate the
 * expected fields at runtime so a missing/malformed event surfaces
 * a clear error instead of `undefined` reads.
 */
export function providerErrorToAPICallError(event: Extract<LLMEvent, { type: "provider-error" }>): APICallError {
  if (!event || typeof event !== "object") {
    throw new Error("providerErrorToAPICallError: event is not an object")
  }
  const rawMessage = (event as { message?: unknown }).message
  const message = typeof rawMessage === "string" && rawMessage.length > 0 ? rawMessage : "Provider error"
  const heuristicRetryable = /rate.?limit|throttl|overloaded|too many requests|\b429\b|\b503\b|\b529\b/i.test(message)
  const isRetryable = event.retryable === true || (event.retryable !== false && heuristicRetryable)

  let statusCode: number | undefined
  const meta = event.providerMetadata
  if (meta && typeof meta === "object") {
    for (const value of Object.values(meta as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue
      const record = value as Record<string, unknown>
      const status = record.statusCode ?? record.status ?? record.status_code
      if (typeof status === "number" && Number.isFinite(status)) {
        statusCode = status
        break
      }
      if (typeof status === "string" && /^\d{3}$/.test(status)) {
        statusCode = Number(status)
        break
      }
    }
  }

  return new APICallError({
    message,
    url: "nikcli://native-llm/provider-error",
    requestBodyValues: undefined,
    statusCode,
    responseHeaders: undefined,
    responseBody: undefined,
    isRetryable,
  })
}

/**
 * The shape `LLMError.reason` has when it carries an HTTP failure.
 *
 * Declared structurally rather than imported as a class: `LLMError` is an
 * Effect `Schema.TaggedError`, so importing it here would pull `Schema` into
 * this module's runtime graph purely to read fields, and the fields are the
 * whole contract anyway. `packages/llm/src/schema/errors.ts` is the authority on
 * what actually arrives.
 */
type NativeHttpReason = {
  readonly _tag?: string
  readonly message?: string
  readonly status?: number
  readonly retryAfterMs?: number
  readonly http?: {
    readonly body?: string
    readonly response?: {
      readonly status?: number
      readonly headers?: Record<string, string>
    }
    readonly rateLimit?: { readonly retryAfterMs?: number }
  }
}

function nativeHttpReason(error: unknown): NativeHttpReason | undefined {
  if (!error || typeof error !== "object") return undefined
  const reason = (error as { reason?: unknown }).reason
  if (!reason || typeof reason !== "object") return undefined
  const record = reason as NativeHttpReason
  // `Transport` and `NoRoute` are excluded on purpose, and the rest is decided
  // by evidence that a real provider response exists rather than by listing
  // tags: a network reset carries a request-only context, so mapping it would
  // invent a status for a request that never got an answer and turn a reset into
  // a fake 500. Two independent pieces of that evidence count — a status or
  // response context, or a parsed `retryAfterMs`, which can only have come from
  // a response header.
  //
  // The second one is not redundant. `RateLimitReason` carries no `status`
  // field at all (`statusReason` in `packages/llm/src/route/executor.ts` builds
  // it from `retryAfterMs`, `rateLimit` and `http`), so a rate-limit reason
  // without a response context would be the one case that fell through and came
  // back as the `UnknownError` this mapping exists to prevent.
  if (record._tag === "Transport" || record._tag === "NoRoute") return undefined
  // `!= null` rather than `typeof === "object"` alone, because `typeof null` is
  // `"object"` and a null `http.response` would otherwise count as a response.
  const nativeResponse = record.http?.response
  const hasResponse =
    typeof record.status === "number" ||
    (nativeResponse != null && typeof nativeResponse === "object") ||
    typeof record.retryAfterMs === "number" ||
    typeof record.http?.rateLimit?.retryAfterMs === "number"
  return hasResponse ? record : undefined
}

/**
 * Map a thrown native `LLMError` to `APICallError`.
 *
 * This is the other half of `providerErrorToAPICallError`, for the failures that
 * arrive as a thrown error instead of an in-band event, and it is where the
 * status and the `Retry-After` headers are actually available.
 *
 * Measured, not assumed: a real 429 carrying `retry-after: 7` makes the native
 * runtime retry twice and then throw `LLMError` whose `reason` is
 * `RateLimit` with `retryAfterMs`, `status` and redacted response headers
 * populated. Without this mapping that error crossed into `MessageV2.fromError`
 * as `UnknownError`, which classifies as non-retryable — so a throttled turn
 * showed an untyped failure and `SessionRetry.delay` never saw the header the
 * provider sent. `specs/effect-tui/11-provider-inference-streaming.md`
 * requirements 6 and 8 ask for exactly the opposite: a typed rate-limit failure
 * carrying `retryAfter`, not a silent non-retry.
 *
 * Headers pass through as the response recorded them, and nothing is recomputed
 * here. They are already redacted at construction in
 * `packages/llm/src/route/executor.ts`.
 */
export function nativeErrorToAPICallError(error: unknown): APICallError | undefined {
  const reason = nativeHttpReason(error)
  if (!reason) return undefined

  const response = reason.http?.response
  const headers = response?.headers
  const statusCode =
    typeof reason.status === "number"
      ? reason.status
      : typeof response?.status === "number"
        ? response.status
        : undefined

  // Deliberately not republishing the executor's parsed `retryAfterMs` under
  // `retry-after-ms`. That value is a snapshot taken at response time, so a
  // date-form `Retry-After` went stale and fired late; `Retry-After: 0` became
  // the truthy string `"0"` and skipped backoff entirely, compounding the
  // runtime's own two retries; and an unbounded value like `Retry-After: +1h`
  // bypassed the 30s no-headers ceiling `SessionRetry.delay` otherwise applies.
  // `SessionRetry.delay` already parses `retry-after-ms`, `retry-after` seconds
  // and `retry-after` dates, so the recorded header is both sufficient and
  // fresher than anything recomputed here.
  return new APICallError({
    message: nativeFailureMessage(reason),
    url: "nikcli://native-llm/request",
    requestBodyValues: undefined,
    statusCode,
    responseHeaders: headers ? { ...headers } : undefined,
    // Deliberately not the provider body: `SessionRetry` classifies any body
    // that merely has an `error` key as "Provider Server Error", which relabels a
    // rate limit as a server fault. `message` already carries the provider's own
    // text and the status.
    responseBody: undefined,
    isRetryable:
      typeof (error as { retryable?: unknown }).retryable === "boolean"
        ? (error as { retryable: boolean }).retryable
        : statusCode !== undefined && (statusCode === 408 || statusCode === 429 || statusCode >= 500),
  })
}

/**
 * The session layer's vocabulary for the reasons the runtime already typed.
 *
 * Requirement 8 asks for a provider rate limit to surface as a typed failure
 * rather than a raw transport string, and `SessionRetry.retryable` recognises
 * these phrasings. Without the map a throttled turn reports the executor's
 * "RequestExecutor.execute: Provider request failed with HTTP 429: …", which is
 * accurate and unreadable; with it the same turn reports "Rate Limited" and the
 * user-facing reason matches the AI SDK path.
 */
function nativeFailureMessage(reason: NativeHttpReason): string {
  switch (reason._tag) {
    case "RateLimit":
      return "Rate Limited"
    case "QuotaExceeded":
      return "Free usage exceeded, add credits https://nikcli-ai.dev/zen"
    case "Authentication":
      return reason.message || "Provider authentication failed"
    case "InvalidRequest":
      return reason.message || "Provider rejected the request"
    case "ContentPolicy":
      return reason.message || "Provider content policy rejected the request"
    case "ProviderInternal":
      return reason.message || "Provider Server Error"
    default:
      return reason.message || "Native provider request failed"
  }
}

type FinishEvent = LLMEvent & { type: "step-finish" | "request-finish" }

/**
 * Finish events that carried no `usage`, against the ones seen.
 *
 * `specs/effect-tui/11-provider-inference-streaming.md` requirement 10: missing
 * usage "must not silently under-report; the aggregator either reconstructs from
 * prior deltas or flags the gap explicitly", and the acceptance line is "Missing
 * `usage` chunks are flagged, not interpolated".
 *
 * This is the flag half, and it is deliberately the cheap half. Nothing here
 * reconstructs a number: `Session.getUsage` still turns absent fields into
 * zeros, and this counter exists precisely so that the resulting zero-billed
 * turn is *counted* rather than looking like a free request. Interpolating from
 * prior deltas would need a real accumulator, which is `Usage.Service` work that
 * has not landed — see the spec's "Review the evidence" section, which still
 * records that service as absent.
 *
 * Counting only, and two integers at that: no provider ids, model ids, prompts
 * or tokens are accepted, because the observation happens below both the model
 * reference and the message, so there is nothing to key on anyway and nothing
 * safe to retain.
 */
let usageFinishes = 0
let usageGaps = 0

export type UsageGapSnapshot = {
  /** Finish events (`step-finish` / `request-finish`) this adapter observed. */
  readonly finishes: number
  /** Those that arrived with no `usage` at all. */
  readonly gaps: number
}

export function usageGap(): UsageGapSnapshot {
  return { finishes: usageFinishes, gaps: usageGaps }
}

/**
 * Module state, so `bun test` shares it across a run: reset in `beforeEach`,
 * not only in `afterEach`, or a test inherits the previous file's counts.
 */
export function resetUsageGap(): void {
  usageFinishes = 0
  usageGaps = 0
}

function usageToAISDK(usage: FinishEvent) {
  const u = usage.usage
  usageFinishes++
  if (!u) {
    usageGaps++
    // Warned per gap rather than folded into a periodic roll-up: a gap is the
    // only thing standing between a silent zero-billed turn and a noticed one, so
    // it should be visible where the turn actually happened.
    log.warn("native finish carried no usage; the turn bills zero tokens", usageGap())
    return undefined
  }
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    reasoningTokens: u.reasoningTokens,
    totalTokens: u.totalTokens,
    cachedInputTokens: u.cacheReadInputTokens,
  }
}

// `LanguageModelV2Usage` has no cache-write field, so Session.getUsage recovers
// it from provider metadata. The native protocols decode cache writes uniformly
// into `Usage.cacheWriteInputTokens`, so republish that under one provider-
// neutral key instead of forcing getUsage to learn every native shape.
function metadataWithCacheWrite(event: FinishEvent) {
  const write = event.usage?.cacheWriteInputTokens
  if (write === undefined) return event.providerMetadata
  return {
    ...event.providerMetadata,
    nikcli: { cacheWriteInputTokens: write },
  }
}

/**
 * The processor bills and snapshots on `finish-step`; without one, a whole
 * assistant turn persists with no finish reason, cost, or token count.
 */
function finishStep(state: AdapterState, event: FinishEvent): ProcessorStreamEvent[] {
  if (state.stepFinished) return []
  state.stepOpen = false
  state.stepFinished = true
  return [
    {
      type: "finish-step",
      finishReason: finishReason(event.reason),
      ...(event.rawReason ? { rawReason: event.rawReason } : undefined),
      usage: usageToAISDK(event),
      providerMetadata: metadataWithCacheWrite(event),
    } as ProcessorStreamEvent,
  ]
}

function startStep(state: AdapterState): ProcessorStreamEvent[] {
  if (state.stepOpen) return []
  state.stepOpen = true
  state.stepFinished = false
  return [{ type: "start-step" } as ProcessorStreamEvent]
}

/**
 * Text and reasoning parts stay `pending` until closed. A provider that ends
 * the request without an explicit `text-end` would otherwise leave the last
 * part of the turn hanging in the UI.
 */
function closeOpenParts(state: AdapterState): ProcessorStreamEvent[] {
  const out: ProcessorStreamEvent[] = []
  if (state.currentReasoningID) {
    out.push({
      type: "reasoning-end",
      id: state.currentReasoningID,
    } as ProcessorStreamEvent)
    state.currentReasoningID = undefined
  }
  if (state.currentTextID) {
    out.push({
      type: "text-end",
      id: state.currentTextID,
    } as ProcessorStreamEvent)
    state.currentTextID = undefined
  }
  return out
}

/**
 * `ToolStateCompleted` demands a string output plus a title and metadata
 * record. nikcli builds those itself for the tools it runs, but a
 * provider-executed tool (Cursor's shell, OpenAI's web search) arrives as raw
 * JSON straight from the wire — persist that as-is and the completed part is
 * rejected by the schema.
 */
function providerExecutedOutput(
  name: string,
  normalized: {
    output: unknown
    title?: string
    metadata?: Record<string, unknown>
  },
) {
  const output =
    typeof normalized.output === "string" ? normalized.output : JSON.stringify(normalized.output ?? "", null, 2)
  return {
    output,
    title: normalized.title ?? name,
    metadata: normalized.metadata ?? {},
  }
}

function normalizeToolOutput(result: unknown): {
  output: unknown
  title?: string
  metadata?: Record<string, unknown>
} {
  if (result && typeof result === "object" && "type" in result) {
    const r = result as { type: string; value?: unknown }
    if (r.type === "text") {
      return { output: r.value ?? "" }
    }
    if (r.type === "json") {
      return { output: r.value }
    }
    if (r.type === "error") {
      return { output: String(r.value ?? "") }
    }
  }
  if (result && typeof result === "object" && "output" in result) {
    const o = result as {
      output?: unknown
      title?: string
      metadata?: Record<string, unknown>
    }
    return { output: o.output, title: o.title, metadata: o.metadata }
  }
  return { output: result }
}

export function mapLLMEvent(state: AdapterState, event: LLMEvent): ProcessorStreamEvent[] {
  switch (event.type) {
    case "request-start": {
      if (state.emittedStart) return []
      state.emittedStart = true
      return [{ type: "start" } as ProcessorStreamEvent, ...startStep(state)]
    }

    case "step-start":
      return startStep(state)

    case "step-finish":
      return finishStep(state, event)

    case "request-finish":
      return [
        ...closeOpenParts(state),
        ...finishStep(state, event),
        {
          type: "finish",
          finishReason: finishReason(event.reason),
        } as ProcessorStreamEvent,
      ]

    case "text-start":
      state.currentTextID = event.id
      return [
        {
          type: "text-start",
          id: event.id,
          providerMetadata: event.providerMetadata,
        } as ProcessorStreamEvent,
      ]

    case "text-delta": {
      // missing start at the adapter boundary. // needs a text part before it can persist the delta, so synthesize the // Native providers may emit deltas without text-start. The processor
      const id = event.id ?? state.currentTextID ?? `text-${state.text++}`
      const out: ProcessorStreamEvent[] = []
      if (!state.currentTextID) {
        state.currentTextID = id
        out.push({
          type: "text-start",
          id,
          providerMetadata: event.providerMetadata,
        } as ProcessorStreamEvent)
      }
      out.push({
        type: "text-delta",
        id,
        text: event.text,
        providerMetadata: event.providerMetadata,
      } as ProcessorStreamEvent)
      return out
    }

    case "text-end":
      if (state.currentTextID === event.id) state.currentTextID = undefined
      return [
        {
          type: "text-end",
          id: event.id,
          providerMetadata: event.providerMetadata,
        } as ProcessorStreamEvent,
      ]

    case "reasoning-delta": {
      const id = event.id ?? `reasoning-${state.reasoning}`
      const out: ProcessorStreamEvent[] = []
      if (state.currentReasoningID !== id) {
        if (state.currentReasoningID) {
          out.push({
            type: "reasoning-end",
            id: state.currentReasoningID,
          } as ProcessorStreamEvent)
        }
        state.currentReasoningID = id
        out.push({
          type: "reasoning-start",
          id,
          providerMetadata: event.providerMetadata,
        } as ProcessorStreamEvent)
      }
      out.push({
        type: "reasoning-delta",
        id,
        text: event.text,
        providerMetadata: event.providerMetadata,
      } as ProcessorStreamEvent)
      return out
    }

    case "tool-input-delta":
      return [
        {
          type: "tool-input-delta",
          id: event.id,
          toolName: event.name,
          delta: event.text,
          providerMetadata: event.providerMetadata,
        } as ProcessorStreamEvent,
      ]

    case "tool-call": {
      const out: ProcessorStreamEvent[] = []
      if (!state.toolInputStarted.has(event.id)) {
        state.toolInputStarted.add(event.id)
        state.toolNames[event.id] = event.name
        out.push({
          type: "tool-input-start",
          id: event.id,
          toolName: event.name,
          providerMetadata: event.providerMetadata,
        } as ProcessorStreamEvent)
        out.push({
          type: "tool-input-end",
          id: event.id,
        } as ProcessorStreamEvent)
      }
      out.push({
        type: "tool-call",
        toolCallId: event.id,
        toolName: event.name,
        input: event.input,
        providerExecuted: event.providerExecuted,
        providerMetadata: event.providerMetadata,
      } as ProcessorStreamEvent)
      return out
    }

    case "tool-result": {
      // A provider-executed tool reports its own failures through the result
      // channel; surfacing that as a successful result would persist the error
      // text as tool output.
      const failed =
        event.result && typeof event.result === "object" && (event.result as { type?: string }).type === "error"
      if (failed) {
        return [
          {
            type: "tool-error",
            toolCallId: event.id,
            toolName: event.name,
            input: undefined,
            error: new Error(String((event.result as { value?: unknown }).value ?? "Tool failed")),
          } as ProcessorStreamEvent,
        ]
      }
      const normalized = normalizeToolOutput(event.result)
      return [
        {
          type: "tool-result",
          toolCallId: event.id,
          toolName: event.name,
          input: undefined,
          output: event.providerExecuted ? providerExecutedOutput(event.name, normalized) : normalized,
          providerExecuted: event.providerExecuted,
        } as ProcessorStreamEvent,
      ]
    }

    case "tool-error":
      return [
        {
          type: "tool-error",
          toolCallId: event.id,
          toolName: event.name,
          input: undefined,
          error: new Error(event.message),
        } as ProcessorStreamEvent,
      ]

    case "provider-error":
      throw providerErrorToAPICallError(event)

    default: {
      log.debug("unmapped llm event", {
        type: (event as { type?: string }).type,
      })
      return []
    }
  }
}

export async function* toProcessorStream(llmEvents: AsyncIterable<LLMEvent>): AsyncGenerator<ProcessorStreamEvent> {
  const state = adapterState()
  try {
    for await (const event of llmEvents) {
      for (const mapped of mapLLMEvent(state, event)) {
        yield mapped
      }
    }
    // A stream that ends without `request-finish` (an aborted turn, a provider
    // that just closes the socket) still has to leave every part closed.
    for (const event of closeOpenParts(state)) {
      yield event
    }
  } catch (e) {
    // The runtime's own failures arrive as thrown `LLMError`s rather than
    // `provider-error` events, and they are the ones that carry an HTTP status
    // and `Retry-After`. Converted here, at the one seam every native failure
    // crosses, so the processor classifies a throttled turn as a retryable
    // `APIError` instead of an opaque `UnknownError`.
    const mapped = nativeErrorToAPICallError(e)
    if (mapped) throw mapped
    if (e instanceof Error) throw e
    throw new Error(String(e))
  }
}

export function suppressEmptyTextResult<
  T extends {
    fullStream: AsyncIterable<ProcessorStreamEvent>
    text: Promise<string>
  },
>(result: T): T {
  result.text.catch(() => {})
  return result
}

export * as LLMEventAdapter from "./llm-event-adapter"
