import { describe, expect, it, spyOn } from "bun:test"
import { APICallError } from "@/provider/error"
import { Log } from "@nikcli-ai/util/log"
import type { LLMEvent } from "@nikcli-ai/llm"
import { jsonSchema, tool, type Tool } from "@/session/llm/types"
import {
  executeTools,
  extractThinkTags,
  mapLLMEvent,
  adapterState,
  toProcessorStream,
  providerErrorToAPICallError,
  streamResult,
  suppressEmptyTextResult,
  usageGap,
  resetUsageGap,
} from "@/session/llm/llm-event-adapter"
import { MessageV2 } from "@/session/message-v2"
import { SessionRetry } from "@/session/retry"

describe("llm-event-adapter", () => {
  it("maps text and step-finish with usage", () => {
    const s = adapterState()
    const events = [
      ...mapLLMEvent(s, { type: "step-start", index: 0 } as LLMEvent),
      ...mapLLMEvent(s, {
        type: "text-delta",
        id: "t1",
        text: "hi",
      } as LLMEvent),
      ...mapLLMEvent(s, {
        type: "step-finish",
        index: 0,
        reason: "stop",
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      } as LLMEvent),
    ]
    expect(events.some((e) => e.type === "start-step")).toBe(true)
    expect(events.some((e) => e.type === "finish-step" && (e as any).usage?.inputTokens === 1)).toBe(true)
    expect(events.some((e) => e.type === "text-delta" && (e as any).text === "hi")).toBe(true)
  })

  it("surfaces request-finish as a finish-step carrying the raw finish reason", () => {
    const events = mapLLMEvent(adapterState(), {
      type: "request-finish",
      reason: "tool-calls",
      rawReason: "tool_use",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    } as LLMEvent)

    const finishStep = events.find((e) => e.type === "finish-step") as any
    expect(finishStep).toBeTruthy()
    expect(finishStep.finishReason).toBe("tool-calls")
    expect(finishStep.rawReason).toBe("tool_use")
    expect(finishStep.usage?.inputTokens).toBe(5)
    // The terminal `finish` still closes the stream.
    expect(events.some((e) => e.type === "finish")).toBe(true)
  })

  it("synthesizes start-step from request-start", () => {
    const events = mapLLMEvent(adapterState(), {
      type: "request-start",
      id: "r1",
    } as LLMEvent)
    expect(events.map((e) => e.type)).toEqual(["start", "start-step"])
  })

  it("closes open text/reasoning before request-finish", () => {
    const s = adapterState()
    mapLLMEvent(s, { type: "text-delta", text: "hi" } as LLMEvent)
    mapLLMEvent(s, { type: "reasoning-delta", text: "think" } as LLMEvent)
    const events = mapLLMEvent(s, {
      type: "request-finish",
      reason: "stop",
    } as LLMEvent)
    expect(events.map((e) => e.type)).toEqual(["reasoning-end", "text-end", "finish-step", "finish"])
  })

  it("omits rawReason when the native event has none", () => {
    const events = mapLLMEvent(adapterState(), {
      type: "request-finish",
      reason: "stop",
    } as LLMEvent)
    const finishStep = events.find((e) => e.type === "finish-step") as any
    expect(finishStep).toBeTruthy()
    expect(finishStep.rawReason).toBeUndefined()
  })

  it("coerces provider-executed tool output to the persisted completed shape", () => {
    const s = adapterState()
    // A json result (like Cursor's shell/bash tool) must become a string output
    // with title/metadata present, or persistence rejects the completed part.
    const events = mapLLMEvent(s, {
      type: "tool-result",
      id: "call_1",
      name: "bash",
      result: { type: "json", value: { exitCode: 0, stdout: "ok" } },
      providerExecuted: true,
    } as LLMEvent)
    const result = events.find((e) => e.type === "tool-result") as any
    expect(result).toBeTruthy()
    expect(typeof result.output.output).toBe("string")
    expect(result.output.output).toContain("exitCode")
    expect(typeof result.output.title).toBe("string")
    expect(result.output.metadata).toEqual({})
    expect(result.providerExecuted).toBe(true)
  })

  it("forwards providerExecuted on tool-call", () => {
    const events = mapLLMEvent(adapterState(), {
      type: "tool-call",
      id: "c1",
      name: "bash",
      input: { command: "ls" },
      providerExecuted: true,
    } as LLMEvent)
    const call = events.find((e) => e.type === "tool-call") as any
    expect(call?.providerExecuted).toBe(true)
  })

  it("maps provider-executed error results to tool-error", () => {
    const events = mapLLMEvent(adapterState(), {
      type: "tool-result",
      id: "c1",
      name: "bash",
      result: { type: "error", value: "permission denied" },
      providerExecuted: true,
    } as LLMEvent)
    expect(events.map((e) => e.type)).toEqual(["tool-error"])
    expect(String((events[0] as any).error)).toContain("permission denied")
  })

  it("starts a text part when a native provider sends a bare delta", () => {
    const events = mapLLMEvent(adapterState(), {
      type: "text-delta",
      text: "hello",
    } as LLMEvent)

    expect(events.map((event) => event.type)).toEqual(["text-start", "text-delta"])
    expect((events[0] as any).id).toBeTruthy()
    expect((events[1] as any).id).toBe((events[0] as any).id)
  })

  it("maps tool-call to tool-input-start and tool-call", () => {
    const s = adapterState()
    const events = mapLLMEvent(s, {
      type: "tool-call",
      id: "call-1",
      name: "read",
      input: { path: "/tmp" },
    } as LLMEvent)
    expect(events.map((e) => e.type)).toEqual(["tool-input-start", "tool-input-end", "tool-call"])
    expect((events[2] as any).toolCallId).toBe("call-1")
  })

  it("maps tool-result to AI SDK output shape", () => {
    const s = adapterState()
    const events = mapLLMEvent(s, {
      type: "tool-result",
      id: "call-1",
      name: "read",
      result: { type: "text", value: "file contents" },
    } as LLMEvent)
    expect(events[0]?.type).toBe("tool-result")
    expect((events[0] as any).output?.output).toBe("file contents")
  })

  it("throws APICallError on provider-error (F1.2 retry parity)", () => {
    const s = adapterState()
    expect(() =>
      mapLLMEvent(s, {
        type: "provider-error",
        message: "rate limited",
        retryable: true,
      } as LLMEvent),
    ).toThrow(APICallError)

    try {
      mapLLMEvent(s, {
        type: "provider-error",
        message: "rate limited",
        retryable: true,
      } as LLMEvent)
    } catch (e) {
      expect(APICallError.isInstance(e)).toBe(true)
      expect((e as APICallError).isRetryable).toBe(true)
      expect((e as APICallError).message).toBe("rate limited")
    }
  })

  it("preserves retryable:false on provider-error", () => {
    const err = providerErrorToAPICallError({
      type: "provider-error",
      message: "invalid request",
      retryable: false,
    } as Extract<LLMEvent, { type: "provider-error" }>)
    expect(err.isRetryable).toBe(false)
  })

  it("heuristically marks throttle messages retryable when flag omitted", () => {
    const err = providerErrorToAPICallError({
      type: "provider-error",
      message: "ThrottlingException: Too many requests",
    } as Extract<LLMEvent, { type: "provider-error" }>)
    expect(err.isRetryable).toBe(true)
  })

  it("fromError + SessionRetry see retryable provider-error as APIError", () => {
    const thrown = providerErrorToAPICallError({
      type: "provider-error",
      message: "Bedrock throttle",
      retryable: true,
    } as Extract<LLMEvent, { type: "provider-error" }>)
    const classified = MessageV2.fromError(thrown, {
      providerID: "amazon-bedrock",
    })
    expect(classified.name).toBe("APIError")
    if (classified.name === "APIError") {
      expect(classified.data.isRetryable).toBe(true)
    }
    expect(SessionRetry.retryable(classified)).toBe("Bedrock throttle")
  })

  it("fromError + SessionRetry skip non-retryable provider-error", () => {
    const thrown = providerErrorToAPICallError({
      type: "provider-error",
      message: "model not found",
      retryable: false,
    } as Extract<LLMEvent, { type: "provider-error" }>)
    const classified = MessageV2.fromError(thrown, { providerID: "openai" })
    expect(classified.name).toBe("APIError")
    expect(SessionRetry.retryable(classified)).toBeUndefined()
  })

  it.each([
    { status: 401, retryable: false, expected: undefined },
    { status: 400, retryable: false, expected: undefined },
    { status: 429, retryable: true, expected: "request failed" },
    { status: 503, retryable: false, expected: "request failed" },
  ])("matches SDK retry classification for native HTTP $status", ({ status, retryable, expected }) => {
    const native = providerErrorToAPICallError({
      type: "provider-error",
      message: "request failed",
      retryable,
      providerMetadata: { provider: { statusCode: String(status) } },
    } as Extract<LLMEvent, { type: "provider-error" }>)
    const sdk = new APICallError({
      message: "request failed",
      url: "https://provider.example/inference",
      requestBodyValues: undefined,
      statusCode: status,
      isRetryable: retryable,
    })

    expect(native.statusCode).toBe(status)
    for (const error of [native, sdk]) {
      const classified = MessageV2.fromError(error, {
        providerID: "test-provider",
      })
      expect(SessionRetry.retryable(classified)).toBe(expected)
    }
  })

  it("currently drops native Retry-After metadata at the API error boundary", () => {
    const error = providerErrorToAPICallError({
      type: "provider-error",
      message: "rate limited",
      retryable: true,
      providerMetadata: {
        provider: { statusCode: 429, responseHeaders: { "retry-after": "7" } },
      },
    } as Extract<LLMEvent, { type: "provider-error" }>)
    const classified = MessageV2.fromError(error, {
      providerID: "test-provider",
    })

    expect(classified).toMatchObject({
      name: "APIError",
      data: { statusCode: 429 },
    })
    expect((classified.data as { responseHeaders?: unknown }).responseHeaders).toBeUndefined()
  })

  it("maps tool-input-delta with delta field", () => {
    const s = adapterState()
    const events = mapLLMEvent(s, {
      type: "tool-input-delta",
      id: "call-1",
      name: "opentui",
      text: '{"x":',
    } as LLMEvent)
    expect((events[0] as any).delta).toBe('{"x":')
  })

  it("streams async iterable", async () => {
    async function* source() {
      yield { type: "request-start", id: "r1", model: {} } as LLMEvent
      yield { type: "text-delta", text: "a" } as LLMEvent
      yield { type: "request-finish", reason: "stop" } as LLMEvent
    }
    const collected: string[] = []
    for await (const e of toProcessorStream(source())) {
      collected.push(e.type)
    }
    expect(collected).toContain("start")
    expect(collected).toContain("text-delta")
    expect(collected).toContain("finish")
  })
})

describe("suppressEmptyTextResult", () => {
  function result(text: Promise<string>) {
    return {
      fullStream: (async function* () {})() as AsyncIterable<never>,
      text,
    }
  }

  it("returns the same object, not a copy", () => {
    const value = result(Promise.resolve("ok"))
    expect(suppressEmptyTextResult(value)).toBe(value)
  })

  it("still rejects for a caller that awaits the text", async () => {
    // This is the property that matters: the helper exists to stop an
    // unhandled-rejection warning on a promise nobody read, not to turn a
    // failed generation into a successful empty one.
    const value = suppressEmptyTextResult(result(Promise.reject(new Error("provider exploded"))))
    await expect(value.text).rejects.toThrow("provider exploded")
  })

  it("leaves a resolved text untouched", async () => {
    const value = suppressEmptyTextResult(result(Promise.resolve("hello")))
    expect(await value.text).toBe("hello")
  })

  it("does not leave the rejection unhandled when nobody reads text", async () => {
    // Without the attached catch this rejection would surface as an unhandled
    // rejection and, under Bun, can take the process down.
    let unhandled: unknown
    const onUnhandled = (reason: unknown) => {
      unhandled = reason
    }
    process.on("unhandledRejection", onUnhandled)
    try {
      suppressEmptyTextResult(result(Promise.reject(new Error("ignored"))))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toBeUndefined()
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })
})

describe("native turn equivalence", () => {
  it("bills each step once and does not bill request totals again", () => {
    const state = adapterState()
    const steps = [
      ...mapLLMEvent(state, { type: "request-start" } as LLMEvent),
      ...mapLLMEvent(state, {
        type: "step-finish",
        index: 0,
        reason: "tool-calls",
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      } as LLMEvent),
      ...mapLLMEvent(state, { type: "step-start", index: 1 } as LLMEvent),
      ...mapLLMEvent(state, {
        type: "step-finish",
        index: 1,
        reason: "stop",
        usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
      } as LLMEvent),
      ...mapLLMEvent(state, {
        type: "request-finish",
        reason: "stop",
        usage: { inputTokens: 30, outputTokens: 5, totalTokens: 35 },
      } as LLMEvent),
    ].filter((event) => event.type === "finish-step")

    expect(steps.map((event) => event.usage)).toEqual([
      { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
    ])
  })

  it("preserves normalized cache writes alongside provider metadata", () => {
    const events = mapLLMEvent(adapterState(), {
      type: "request-finish",
      reason: "stop",
      usage: {
        inputTokens: 100,
        outputTokens: 5,
        reasoningTokens: 2,
        totalTokens: 105,
        cacheReadInputTokens: 30,
        cacheWriteInputTokens: 20,
      },
      providerMetadata: { anthropic: { cacheCreationInputTokens: 99 } },
    } as LLMEvent)
    const step = events.find((event) => event.type === "finish-step")

    expect(step?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 5,
      reasoningTokens: 2,
      totalTokens: 105,
      cachedInputTokens: 30,
    })
    expect(step?.providerMetadata).toEqual({
      anthropic: { cacheCreationInputTokens: 99 },
      nikcli: { cacheWriteInputTokens: 20 },
    })
  })

  it("flags absent native finish usage instead of interpolating it", () => {
    resetUsageGap()
    const warn = spyOn(Log.create({ service: "llm-event-adapter" }), "warn")
    try {
      const events = mapLLMEvent(adapterState(), {
        type: "request-finish",
        reason: "stop",
      } as LLMEvent)
      const step = events.find((event) => event.type === "finish-step")

      // Still no usage: reconstructing one from prior deltas needs the
      // accumulator the spec says is absent. What changes is that the gap is
      // counted and announced instead of reading as a free request.
      expect(step).toBeDefined()
      expect(step?.usage).toBeUndefined()
      expect(usageGap()).toEqual({ finishes: 1, gaps: 1 })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain("no usage")
    } finally {
      warn.mockRestore()
    }
  })

  it("counts a finish that reported usage as no gap", () => {
    resetUsageGap()
    mapLLMEvent(adapterState(), {
      type: "request-finish",
      reason: "stop",
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    } as LLMEvent)

    expect(usageGap()).toEqual({ finishes: 1, gaps: 0 })
  })

  it("counts every finish event once even when a turn finishes twice", () => {
    resetUsageGap()
    const state = adapterState()
    mapLLMEvent(state, {
      type: "step-finish",
      index: 0,
      reason: "stop",
    } as LLMEvent)
    mapLLMEvent(state, {
      type: "request-finish",
      reason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as LLMEvent)

    // The second finish is dropped as a duplicate step, so it is not observed
    // twice: a gap count that disagreed with the turns would be its own lie.
    expect(usageGap()).toEqual({ finishes: 1, gaps: 1 })
  })

  it("propagates a mid-stream provider failure without synthesizing finish events", async () => {
    async function* source(): AsyncGenerator<LLMEvent> {
      yield { type: "request-start" } as LLMEvent
      yield { type: "text-delta", id: "t1", text: "partial" } as LLMEvent
      yield {
        type: "provider-error",
        message: "overloaded",
        retryable: true,
      } as LLMEvent
    }
    const events: string[] = []
    const consume = async () => {
      for await (const event of toProcessorStream(source())) events.push(event.type)
    }

    await expect(consume()).rejects.toThrow(APICallError)
    expect(events).toEqual(["start", "start-step", "text-start", "text-delta"])
  })

  it("releases the source iterator when its consumer stops early", async () => {
    let released = false
    let advanced = false
    async function* source(): AsyncGenerator<LLMEvent> {
      try {
        yield { type: "text-delta", id: "t1", text: "first" } as LLMEvent
        advanced = true
        yield { type: "text-delta", id: "t1", text: "late" } as LLMEvent
      } finally {
        released = true
      }
    }

    for await (const event of toProcessorStream(source())) {
      // The step opens before content, so the first thing a consumer can stop on is `start`.
      expect(event.type).toBe("start")
      break
    }
    expect(released).toBe(true)
    expect(advanced).toBe(false)
  })

  /**
   * One complete turn through the native path, pinned as a sequence.
   *
   * `specs/effect-tui/11-provider-inference-streaming.md` asks for the native
   * adapter and the AI SDK path to converge on identical processor-visible
   * output. The per-event tests above check each mapping in isolation; what
   * they cannot see is the **shape of a whole turn** — whether a step is opened
   * exactly once, whether an open text part is closed before the turn
   * finishes, and in what order.
   *
   * Those are the properties that break when a provider emits a slightly
   * different event mix, and the symptom is a transcript that renders wrong
   * rather than an error. Pinning the sequence makes a divergence a failing
   * test instead of a screenshot.
   */
  it("emits one ordered sequence for a text-then-tool turn", () => {
    const state = adapterState()
    const emitted = [
      ...mapLLMEvent(state, { type: "request-start" } as LLMEvent),
      ...mapLLMEvent(state, { type: "text-start", id: "t1" } as LLMEvent),
      ...mapLLMEvent(state, {
        type: "text-delta",
        id: "t1",
        text: "look",
      } as LLMEvent),
      ...mapLLMEvent(state, { type: "text-end", id: "t1" } as LLMEvent),
      ...mapLLMEvent(state, {
        type: "tool-call",
        id: "c1",
        name: "read",
        input: { path: "a.ts" },
      } as LLMEvent),
      ...mapLLMEvent(state, {
        type: "tool-result",
        id: "c1",
        name: "read",
        result: { type: "json", value: { contents: "ok" } },
      } as LLMEvent),
      ...mapLLMEvent(state, {
        type: "request-finish",
        reason: "stop",
      } as LLMEvent),
    ].map((event) => event.type)

    expect(emitted).toEqual([
      // The turn is wrapped: `start`/`finish` frame it, `start-step`/
      // `finish-step` frame the billed step inside it. Both pairs matter —
      // the processor snapshots against the step and the session against the
      // turn.
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-start",
      "tool-input-end",
      "tool-call",
      "tool-result",
      "finish-step",
      "finish",
    ])
  })

  it("opens the step exactly once when a provider emits both request-start and step-start", () => {
    // No native protocol emits both, but nothing stops one from doing so, and
    // a doubled step is billed and snapshotted twice.
    const state = adapterState()
    const opens = [
      ...mapLLMEvent(state, { type: "request-start" } as LLMEvent),
      ...mapLLMEvent(state, { type: "step-start", index: 0 } as LLMEvent),
    ].filter((event) => event.type === "start-step")

    expect(opens).toHaveLength(1)
  })

  it("closes an open text part before finishing, without a text-end from the provider", () => {
    // A provider that ends the request with a text part still streaming must
    // not leave the part open: the renderer would keep it in the live slot.
    const state = adapterState()
    const emitted = [
      ...mapLLMEvent(state, { type: "request-start" } as LLMEvent),
      ...mapLLMEvent(state, {
        type: "text-delta",
        id: "t1",
        text: "partial",
      } as LLMEvent),
      ...mapLLMEvent(state, {
        type: "request-finish",
        reason: "stop",
      } as LLMEvent),
    ].map((event) => event.type)

    expect(emitted.indexOf("text-end")).toBeGreaterThan(-1)
    expect(emitted.indexOf("text-end")).toBeLessThan(emitted.indexOf("finish-step"))
  })
})

describe("executeTools", () => {
  type Event = Parameters<typeof executeTools>[0] extends AsyncIterable<infer T> ? T : never

  async function* source(events: object[]): AsyncGenerator<Event> {
    for (const event of events) yield event as Event
  }

  async function run(events: object[], tools: Record<string, Tool>, abort = new AbortController().signal) {
    const out: Event[] = []
    for await (const event of executeTools(source(events), { tools, messages: [], abort })) out.push(event)
    return out
  }

  const call = (toolName: string, input: unknown, extra: object = {}) => ({
    type: "tool-call",
    toolCallId: "call_1",
    toolName,
    input,
    ...extra,
  })

  const finish = { type: "finish-step" }

  const bash = tool({
    description: "run",
    // Validation fills the default, as a schema with defaults does: the validated input is what runs.
    inputSchema: jsonSchema<{ command: string; timeout: number }>(
      {
        type: "object",
        properties: { command: { type: "string" }, timeout: { type: "number" } },
        required: ["command"],
      },
      {
        validate: (value) => {
          const input = value as { command?: unknown; timeout?: unknown }
          if (typeof input.command !== "string") return { success: false, error: new Error("command must be a string") }
          return { success: true, value: { command: input.command, timeout: Number(input.timeout ?? 5) } }
        },
      },
    ),
    execute: async (input) => ({ title: "bash", output: `ran ${input.command} ${input.timeout}`, metadata: {} }),
  })

  it("runs a client tool and emits its result before the step closes", async () => {
    const events = await run([call("bash", { command: "pwd" }), finish], { bash })
    expect(events.map((event) => event.type)).toEqual(["tool-call", "tool-result", "finish-step"])
    // The validated input is what runs, so schema defaults apply.
    expect(events[1]).toMatchObject({
      toolCallId: "call_1",
      toolName: "bash",
      input: { command: "pwd", timeout: 5 },
      output: { output: "ran pwd 5" },
    })
  })

  it("runs a tool whose schema is plain JSON schema", async () => {
    const seen: unknown[] = []
    const plain = tool({
      description: "mcp",
      inputSchema: jsonSchema<{ q: string }>({
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      }),
      execute: async (input) => {
        seen.push(input)
        return { output: "ok", title: "", metadata: {} }
      },
    })
    const events = await run([call("plain", { q: "x" }), finish], { plain })
    expect(events[1]).toMatchObject({ type: "tool-result" })
    expect(seen).toEqual([{ q: "x" }])
  })

  it("repairs a wrong-cased tool name", async () => {
    const events = await run([call("BASH", { command: "pwd" }), finish], { bash })
    expect(events[0]).toMatchObject({ type: "tool-call", toolName: "bash" })
    expect(events[1]).toMatchObject({ type: "tool-result", toolName: "bash" })
  })

  it("routes an unknown tool to the invalid tool with the reason", async () => {
    const invalid = tool({
      description: "invalid",
      inputSchema: jsonSchema<{ tool: string; error: string }>({
        type: "object",
        properties: { tool: { type: "string" }, error: { type: "string" } },
      }),
      execute: async (input) => ({ output: `${input.tool}: ${input.error}`, title: "", metadata: {} }),
    })
    const events = await run([call("nope", {}), finish], { invalid })
    expect(events[0]).toMatchObject({ type: "tool-call", toolName: "invalid" })
    expect(events[1]).toMatchObject({
      type: "tool-result",
      toolName: "invalid",
      output: { output: expect.stringContaining("nope") },
    })
  })

  it("routes input the schema rejects to the invalid tool", async () => {
    const invalid = tool({
      description: "invalid",
      inputSchema: jsonSchema<{ tool: string; error: string }>({
        type: "object",
        properties: { tool: { type: "string" }, error: { type: "string" } },
      }),
      execute: async (input) => ({ output: input.error, title: "", metadata: {} }),
    })
    const events = await run([call("bash", { command: 7 }), finish], { bash, invalid })
    expect(events[0]).toMatchObject({ type: "tool-call", toolName: "invalid" })
    expect(events[1]).toMatchObject({
      type: "tool-result",
      output: { output: expect.stringContaining("Invalid input for tool bash") },
    })
  })

  it("reports a throwing tool as tool-error and still closes the step", async () => {
    const boom = tool({
      description: "boom",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: async (): Promise<{ output: string }> => {
        throw new Error("exploded")
      },
    })
    const events = await run([call("boom", {}), finish], { boom })
    expect(events.map((event) => event.type)).toEqual(["tool-call", "tool-error", "finish-step"])
    expect(String((events[1] as { error: unknown }).error)).toContain("exploded")
  })

  it("passes provider-executed calls through without running them", async () => {
    const events = await run([call("web_search", { q: "x" }, { providerExecuted: true }), finish], {})
    expect(events.map((event) => event.type)).toEqual(["tool-call", "finish-step"])
  })

  it("starts a tool while the model stream is still open", async () => {
    let started = false
    const slow = tool({
      description: "slow",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: async () => {
        started = true
        return { output: "done", title: "", metadata: {} }
      },
    })
    let startedBeforeNext = false
    async function* events(): AsyncGenerator<Event> {
      yield call("slow", {}) as Event
      await new Promise((resolve) => setTimeout(resolve, 5))
      startedBeforeNext = started
      yield finish as Event
    }
    const out: string[] = []
    for await (const event of executeTools(events(), {
      tools: { slow },
      messages: [],
      abort: new AbortController().signal,
    }))
      out.push(event.type)
    expect(startedBeforeNext).toBe(true)
    expect(out).toEqual(["tool-call", "tool-result", "finish-step"])
  })

  it("hands the tool its call id and abort signal", async () => {
    const controller = new AbortController()
    let received: { toolCallId?: string; abortSignal?: AbortSignal } = {}
    const probe = tool({
      description: "probe",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: async (_input, options) => {
        received = options
        return { output: "", title: "", metadata: {} }
      },
    })
    await run([call("probe", {}), finish], { probe }, controller.signal)
    expect(received.toolCallId).toBe("call_1")
    expect(received.abortSignal).toBe(controller.signal)
  })
})

describe("extractThinkTags", () => {
  async function* source(events: LLMEvent[]): AsyncGenerator<LLMEvent> {
    for (const event of events) yield event
  }

  const delta = (text: string) => ({ type: "text-delta", id: "t", text }) as LLMEvent

  async function run(...deltas: string[]) {
    const events: LLMEvent[] = [...deltas.map(delta), { type: "request-finish", reason: "stop" } as LLMEvent]
    const text: string[] = []
    const reasoning: string[] = []
    for await (const event of extractThinkTags(source(events))) {
      if (event.type === "text-delta") text.push(event.text)
      if (event.type === "reasoning-delta") reasoning.push(event.text)
    }
    return { text: text.join(""), reasoning: reasoning.join("") }
  }

  it("moves a think block out of text", async () => {
    expect(await run("<think>plan</think>answer")).toEqual({ text: "answer", reasoning: "plan" })
  })

  it("leaves untagged text alone", async () => {
    expect(await run("just ", "text")).toEqual({ text: "just text", reasoning: "" })
  })

  it("handles tags split across deltas at every boundary", async () => {
    const whole = "<think>plan</think>answer"
    for (let cut = 1; cut < whole.length; cut++) {
      expect(await run(whole.slice(0, cut), whole.slice(cut))).toEqual({ text: "answer", reasoning: "plan" })
    }
  })

  it("does not swallow a '<' that is not a tag", async () => {
    expect(await run("a < b and <thing>", " done")).toEqual({ text: "a < b and <thing> done", reasoning: "" })
  })

  it("flushes a held fragment when the request ends", async () => {
    expect(await run("ends with <thi")).toEqual({ text: "ends with <thi", reasoning: "" })
  })

  it("treats an unclosed think block as reasoning to the end", async () => {
    expect(await run("<think>never closed")).toEqual({ text: "", reasoning: "never closed" })
  })

  it("gives separate think blocks separate reasoning ids", async () => {
    const ids = new Set<string>()
    for await (const event of extractThinkTags(
      source([delta("<think>a</think>x<think>b</think>y"), { type: "request-finish", reason: "stop" } as LLMEvent]),
    )) {
      if (event.type === "reasoning-delta") ids.add(event.id as string)
    }
    expect(ids.size).toBe(2)
  })
})

describe("toProcessorStream step opening", () => {
  async function* source(events: LLMEvent[]): AsyncGenerator<LLMEvent> {
    for (const event of events) yield event
  }
  const types = async (events: LLMEvent[]) => {
    const out: string[] = []
    for await (const event of toProcessorStream(source(events))) out.push(event.type)
    return out
  }

  it("opens the step on the first event when the provider never sends request-start", async () => {
    const out = await types([
      { type: "text-delta", id: "t", text: "hi" } as LLMEvent,
      { type: "request-finish", reason: "stop" } as LLMEvent,
    ])
    expect(out.slice(0, 2)).toEqual(["start", "start-step"])
    expect(out.filter((type) => type === "start-step")).toHaveLength(1)
    expect(out.indexOf("start-step")).toBeLessThan(out.indexOf("finish-step"))
  })

  it("does not open a second step when request-start is sent", async () => {
    const out = await types([
      { type: "request-start" } as LLMEvent,
      { type: "text-delta", id: "t", text: "hi" } as LLMEvent,
      { type: "request-finish", reason: "stop" } as LLMEvent,
    ])
    expect(out.filter((type) => type === "start")).toHaveLength(1)
    expect(out.filter((type) => type === "start-step")).toHaveLength(1)
  })
})

describe("streamResult", () => {
  type Event = Parameters<typeof streamResult>[0] extends AsyncIterable<infer T> ? T : never
  const delta = (text: string) => ({ type: "text-delta", id: "t", text }) as Event

  function source(events: Event[], failure?: Error) {
    const state = { started: false, released: false }
    const iterable: AsyncIterable<Event> = {
      [Symbol.asyncIterator]() {
        state.started = true
        let index = 0
        return {
          async next() {
            if (index < events.length) return { value: events[index++]!, done: false }
            if (failure) throw failure
            return { value: undefined, done: true }
          },
          async return() {
            state.released = true
            return { value: undefined, done: true }
          },
        }
      },
    }
    return { state, iterable }
  }

  it("does not touch the source until a consumer asks", () => {
    const { state, iterable } = source([delta("a")])
    streamResult(iterable)
    expect(state.started).toBe(false)
  })

  it("resolves text from the stream without anyone iterating it", async () => {
    const { iterable } = source([delta("hel"), delta("lo")])
    expect(await streamResult(iterable).text).toBe("hello")
  })

  it("still replays the whole turn to fullStream after text was read", async () => {
    const { iterable } = source([delta("a"), delta("b")])
    const result = streamResult(iterable)
    await result.text
    const seen: string[] = []
    for await (const event of result.fullStream) seen.push((event as { text: string }).text)
    expect(seen).toEqual(["a", "b"])
  })

  it("serves text and fullStream consumers from one pass", async () => {
    let pulls = 0
    async function* counted(): AsyncGenerator<Event> {
      pulls++
      yield delta("x")
      yield delta("y")
    }
    const result = streamResult(counted())
    const [text, events] = await Promise.all([
      result.text,
      (async () => {
        const out: Event[] = []
        for await (const event of result.fullStream) out.push(event)
        return out
      })(),
    ])
    expect(text).toBe("xy")
    expect(events).toHaveLength(2)
    expect(pulls).toBe(1)
  })

  it("releases the source when the stream consumer stops early and text was not requested", async () => {
    const { state, iterable } = source([delta("a"), delta("b"), delta("c")])
    for await (const _ of streamResult(iterable).fullStream) break
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state.released).toBe(true)
  })

  it("surfaces a failure to both consumers", async () => {
    const boom = new Error("provider exploded")
    const first = streamResult(source([delta("a")], boom).iterable)
    await expect(first.text).rejects.toBe(boom)
    const second = streamResult(source([delta("a")], boom).iterable)
    const seen: Event[] = []
    await expect(
      (async () => {
        for await (const event of second.fullStream) seen.push(event)
      })(),
    ).rejects.toBe(boom)
    expect(seen).toHaveLength(1)
  })
})
