import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { jsonSchema, tool, type ModelMessage } from "@/session/llm/types"
import * as LLMCoverage from "@/session/llm/coverage"
import { withFixture } from "../helpers/fixture"

/**
 * The native route end to end against a real HTTP server: the request a session sends
 * (system prompt, tool schemas, tool history) and the stream it gets back (tool call, executed tool,
 * step close). Nothing between `LLM.stream` and the socket is mocked.
 */

type Captured = { path: string; headers: Headers; body: any }

const sse = (...chunks: object[]) =>
  chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"

const chunk = (delta: object, finish: string | null = null, usage: object | null = null) => ({
  id: "chatcmpl_e2e",
  choices: [{ index: 0, delta, finish_reason: finish }],
  usage,
})

describe("native LLM stream end to end", () => {
  const captured: Captured[] = []
  const replies: string[] = []
  let server: ReturnType<typeof Bun.serve>

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        captured.push({
          path: new URL(request.url).pathname,
          headers: request.headers,
          body: await request.json(),
        })
        return new Response(replies.shift() ?? sse(chunk({}, "stop")), {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
  })

  afterAll(() => server.stop(true))

  async function session(
    body: (ctx: {
      stream: typeof import("@/session/llm").LLM.stream
      input: import("@/session/llm").LLM.StreamInput
    }) => Promise<void>,
  ) {
    await withFixture(async ({ home }) => {
      const previous = process.env.NIKCLI_DISABLE_PROJECT_CONFIG
      const previousModelsFetch = process.env.NIKCLI_DISABLE_MODELS_FETCH
      process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "0"
      process.env.NIKCLI_DISABLE_MODELS_FETCH = "1"
      const { Instance } = await import("@/project/instance")
      const { Provider } = await import("@/provider/provider")
      const { LLM } = await import("@/session/llm")
      const { runPromiseWithLayer, withCurrentInstance } = await import("@/effect")
      try {
        await Bun.write(
          path.join(home, "nikcli.json"),
          JSON.stringify({
            experimental: { openTelemetry: false },
            enabled_providers: ["native-e2e"],
            provider: {
              "native-e2e": {
                npm: "@ai-sdk/openai-compatible",
                api: `http://127.0.0.1:${server.port}/v1`,
                options: { apiKey: "e2e-key", headers: { "x-gateway": "yes" } },
                models: {
                  m: {
                    name: "M",
                    limit: { context: 8192, output: 1024 },
                    tool_call: true,
                    attachment: true,
                    modalities: { input: ["text", "image"], output: ["text"] },
                  },
                },
              },
            },
          }),
        )
        await Instance.provide({
          directory: home,
          fn: async () => {
            const model = await runPromiseWithLayer(
              Provider.defaultLayer,
              withCurrentInstance(
                Effect.gen(function* () {
                  const provider = yield* Provider.Service
                  return yield* provider.getModel("native-e2e", "m")
                }),
              ),
            )
            const input: import("@/session/llm").LLM.StreamInput = {
              sessionID: "ses_native_e2e",
              user: {
                id: "msg_e2e",
                sessionID: "ses_native_e2e",
                role: "user",
                time: { created: 0 },
                agent: "build",
                model: { providerID: model.providerID, modelID: model.id },
              },
              agent: { name: "build", mode: "primary", options: {}, permission: [], prompt: "AGENT PROMPT" },
              model,
              system: ["CUSTOM SYSTEM"],
              messages: [{ role: "user", content: "run pwd" }],
              tools: {},
              abort: new AbortController().signal,
            }
            LLMCoverage.reset()
            await body({ stream: LLM.stream, input })
            // Guards the whole file: every turn must stream natively (none refused, none unmapped); a refused turn would fail,
            // so this also guards the coverage bookkeeping.
            expect(LLMCoverage.summary()).toMatchObject({
              native: 1,
              ineligible: 0,
              "ineligible-late": 0,
              unmapped: 0,
            })
          },
        })
      } finally {
        await Instance.disposeAll()
        if (previous === undefined) delete process.env.NIKCLI_DISABLE_PROJECT_CONFIG
        else process.env.NIKCLI_DISABLE_PROJECT_CONFIG = previous
        if (previousModelsFetch === undefined) delete process.env.NIKCLI_DISABLE_MODELS_FETCH
        else process.env.NIKCLI_DISABLE_MODELS_FETCH = previousModelsFetch
      }
    })
  }

  async function collect(result: { fullStream: AsyncIterable<{ type: string }> }) {
    const events: Array<Record<string, any>> = []
    for await (const event of result.fullStream) events.push(event as Record<string, any>)
    return events
  }

  const bash = tool({
    description: "Run a shell command",
    inputSchema: jsonSchema<{ command: string }>({
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    }),
    execute: async (input) => ({ title: "bash", output: `ran: ${input.command}`, metadata: {} }),
  })

  it("sends the assembled system prompt, tool schemas and provider headers", async () => {
    captured.length = 0
    replies.push(
      sse(chunk({ role: "assistant", content: "hi" }), chunk({}, "stop", { prompt_tokens: 3, completion_tokens: 1 })),
    )
    await session(async ({ stream, input }) => {
      const events = await collect(await stream({ ...input, tools: { bash } }))
      expect(events.map((e) => e.type)).toContain("text-delta")
      expect(events.at(-1)?.type).toBe("finish")
    })

    expect(captured).toHaveLength(1)
    const request = captured[0]!
    expect(request.path).toBe("/v1/chat/completions")
    expect(request.headers.get("authorization")).toBe("Bearer e2e-key")
    expect(request.headers.get("x-gateway")).toBe("yes")
    const system = request.body.messages.filter((m: any) => m.role === "system")
    const systemText = JSON.stringify(system)
    expect(systemText).toContain("AGENT PROMPT")
    expect(systemText).toContain("CUSTOM SYSTEM")
    expect(request.body.tools).toEqual([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({
          name: "bash",
          parameters: expect.objectContaining({ properties: { command: { type: "string" } } }),
        }),
      }),
    ])
  })

  it("resolves result.text for callers that never iterate the stream (titles, summaries)", async () => {
    captured.length = 0
    replies.push(sse(chunk({ role: "assistant", content: "A short " }), chunk({ content: "title" }), chunk({}, "stop")))
    await session(async ({ stream, input }) => {
      const result = await stream(input)
      expect(await result.text).toBe("A short title")
    })
  })

  it("executes a client tool and emits its result before the step finishes", async () => {
    captured.length = 0
    replies.push(
      sse(
        chunk({
          role: "assistant",
          tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: '{"command":"pwd"}' } }],
        }),
        chunk({}, "tool_calls"),
      ),
    )
    await session(async ({ stream, input }) => {
      const events = await collect(await stream({ ...input, tools: { bash } }))
      const types = events.map((e) => e.type)
      expect(types.slice(0, 2)).toEqual(["start", "start-step"])
      expect(types).toContain("tool-call")
      const result = events.find((e) => e.type === "tool-result")
      expect(result).toMatchObject({ toolCallId: "call_1", toolName: "bash", output: { output: "ran: pwd" } })
      expect(types.indexOf("tool-result")).toBeLessThan(types.indexOf("finish-step"))
    })
  })

  it("replays tool calls and results in the next request, paired by id", async () => {
    captured.length = 0
    replies.push(sse(chunk({ role: "assistant", content: "done" }), chunk({}, "stop")))
    const messages: ModelMessage[] = [
      { role: "user", content: "run pwd" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call_1", toolName: "bash", input: { command: "pwd" } },
          { type: "tool-call", toolCallId: "call_2", toolName: "bash", input: { command: "ls" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call_1", toolName: "bash", output: { type: "text", value: "/work" } },
          { type: "tool-result", toolCallId: "call_2", toolName: "bash", output: { type: "text", value: "a b" } },
        ],
      },
    ]
    await session(async ({ stream, input }) => {
      await collect(await stream({ ...input, tools: { bash }, messages }))
    })

    const sent = captured[0]!.body.messages.filter((m: any) => m.role !== "system")
    expect(sent.map((m: any) => m.role)).toEqual(["user", "assistant", "tool", "tool"])
    expect(sent[1].tool_calls.map((c: any) => c.id)).toEqual(["call_1", "call_2"])
    expect(sent[2]).toMatchObject({ tool_call_id: "call_1", content: "/work" })
    expect(sent[3]).toMatchObject({ tool_call_id: "call_2", content: "a b" })
  })

  it("sends an attached image as an image part", async () => {
    captured.length = 0
    replies.push(sse(chunk({ role: "assistant", content: "ok" }), chunk({}, "stop")))
    await session(async ({ stream, input }) => {
      await collect(
        await stream({
          ...input,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "what is this" },
                { type: "image", image: "data:image/png;base64,AAECAw==" },
              ],
            },
          ],
        }),
      )
    })
    const user = captured[0]!.body.messages.find((m: any) => m.role === "user")
    expect(user.content).toEqual([
      { type: "text", text: "what is this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAECAw==" } },
    ])
  })
})
