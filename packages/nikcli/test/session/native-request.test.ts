import { describe, expect, it } from "bun:test"
import { jsonSchema, tool, type ModelMessage } from "@/session/llm/types"
import {
  NativeRequestUnsupported,
  toLLMMessages,
  toLLMProviderOptions,
  toLLMToolChoice,
  toLLMToolDefinitions,
} from "@/session/llm/native-request"

describe("toLLMMessages", () => {
  it("keeps tool calls and pairs every tool result with its call", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool-call", toolCallId: "call_1", toolName: "bash", input: { cmd: "ls" } },
          { type: "tool-call", toolCallId: "call_2", toolName: "read", input: { p: "a" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call_1", toolName: "bash", output: { type: "text", value: "a b" } },
          { type: "tool-result", toolCallId: "call_2", toolName: "read", output: { type: "json", value: { n: 1 } } },
        ],
      },
    ]

    const result = toLLMMessages(messages)

    expect(result.map((m) => m.role)).toEqual(["user", "assistant", "tool"])
    expect(result[1]!.content).toEqual([
      { type: "text", text: "calling" },
      { type: "tool-call", id: "call_1", name: "bash", input: { cmd: "ls" } },
      { type: "tool-call", id: "call_2", name: "read", input: { p: "a" } },
    ])
    expect(result[2]!.content).toEqual([
      { type: "tool-result", id: "call_1", name: "bash", result: { type: "text", value: "a b" } },
      { type: "tool-result", id: "call_2", name: "read", result: { type: "json", value: { n: 1 } } },
    ])
  })

  it("maps error outputs and text-only content outputs", () => {
    const result = toLLMMessages([
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "a", toolName: "t", output: { type: "error-text", value: "bad" } },
          {
            type: "tool-result",
            toolCallId: "b",
            toolName: "t",
            output: {
              type: "content",
              value: [
                { type: "text", text: "one" },
                { type: "text", text: "two" },
              ],
            },
          },
        ],
      },
    ])
    expect(result[0]!.content).toMatchObject([
      { result: { type: "error", value: "bad" } },
      { result: { type: "text", value: "one\ntwo" } },
    ])
  })

  it("refuses tool results that carry media", () => {
    expect(() =>
      toLLMMessages([
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "a",
              toolName: "t",
              output: { type: "content", value: [{ type: "media", data: "AAAA", mediaType: "image/png" }] },
            },
          ],
        },
      ]),
    ).toThrow(NativeRequestUnsupported)
  })

  it("skips system messages: the request carries its own system parts", () => {
    const result = toLLMMessages([
      { role: "system", content: "be brief" },
      { role: "user", content: "hello" },
    ])
    expect(result.map((m) => m.role)).toEqual(["user"])
  })

  it("converts images and files to base64 media, stripping data URL prefixes", () => {
    const result = toLLMMessages([
      {
        role: "user",
        content: [
          { type: "image", image: "data:image/jpeg;base64,AAECAw==" },
          { type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "application/pdf", filename: "a.pdf" },
          { type: "image", image: "AAEC", mediaType: "image/webp" },
        ],
      },
    ])
    expect(result[0]!.content).toEqual([
      { type: "media", mediaType: "image/jpeg", data: "AAECAw==" },
      { type: "media", mediaType: "application/pdf", data: new Uint8Array([1, 2, 3]), filename: "a.pdf" },
      { type: "media", mediaType: "image/webp", data: "AAEC" },
    ])
  })

  it("refuses remote media URLs rather than sending them as base64", () => {
    for (const image of ["https://example.com/a.png", new URL("https://example.com/a.png")]) {
      expect(() => toLLMMessages([{ role: "user", content: [{ type: "image", image }] }])).toThrow(
        NativeRequestUnsupported,
      )
    }
  })

  it("carries reasoning replay metadata and message-level options", () => {
    const result = toLLMMessages([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "think", providerOptions: { anthropic: { signature: "sig" } } },
          { type: "text", text: "answer" },
        ],
        providerOptions: { openaiCompatible: { reasoning_content: "think" } },
      },
    ])
    expect(result[0]!.content[0]).toEqual({
      type: "reasoning",
      text: "think",
      providerMetadata: { anthropic: { signature: "sig" } },
    })
    expect(result[0]!.native).toEqual({ openaiCompatible: { reasoning_content: "think" } })
  })

  it("marks provider-executed tool calls and their results", () => {
    const result = toLLMMessages([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "s1", toolName: "web_search", input: { q: "x" }, providerExecuted: true },
          { type: "tool-result", toolCallId: "s1", toolName: "web_search", output: { type: "json", value: [] } },
        ],
      },
    ])
    expect(result[0]!.content).toMatchObject([
      { type: "tool-call", providerExecuted: true },
      { type: "tool-result", providerExecuted: true },
    ])
  })

  it("drops empty text so providers are not sent blank blocks", () => {
    const result = toLLMMessages([
      { role: "user", content: "" },
      { role: "assistant", content: [{ type: "text", text: "" }] },
    ])
    expect(result).toEqual([])
  })
})

describe("toLLMToolDefinitions", () => {
  it("passes a tool's JSON schema through", () => {
    const definitions = toLLMToolDefinitions({
      plain: tool({
        description: "p",
        inputSchema: jsonSchema({ type: "object", properties: { b: { type: "number" } } }),
        execute: async () => "",
      }),
    })
    expect(definitions.map((d) => d.name)).toEqual(["plain"])
    expect(definitions[0]!.inputSchema).toMatchObject({ type: "object", properties: { b: { type: "number" } } })
  })

  it("gives a tool with no schema an empty object schema", () => {
    const definitions = toLLMToolDefinitions({ bare: tool({ description: "b", execute: async () => "" }) })
    expect(definitions[0]!.inputSchema).toEqual({ type: "object", properties: {} })
  })

  it("leaves out deferred tools and tools with no description", () => {
    const t = (description?: string) =>
      tool({ description, inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "" })
    const definitions = toLLMToolDefinitions({ a: t("a"), b: t("b"), c: t() }, new Set(["b"]))
    expect(definitions.map((d) => d.name)).toEqual(["a"])
  })
})

describe("toLLMToolChoice", () => {
  it("maps required and none to their modes, leaving auto to the provider", () => {
    expect(toLLMToolChoice("required")).toMatchObject({ type: "required" })
    expect(toLLMToolChoice("none")).toMatchObject({ type: "none" })
    expect(toLLMToolChoice("auto")).toBeUndefined()
    expect(toLLMToolChoice(undefined)).toBeUndefined()
    expect(toLLMToolChoice({ type: "tool", toolName: "bash" })).toMatchObject({ type: "tool", name: "bash" })
  })
})

describe("toLLMProviderOptions", () => {
  it("re-keys an OpenAI-compatible provider's options to the namespace the route reads", () => {
    for (const route of ["openai-responses", "openai-chat", "openai-compatible-chat"]) {
      expect(toLLMProviderOptions(route, { xai: { reasoningEffort: "high" } })).toMatchObject({
        openai: { reasoningEffort: "high" },
      })
    }
  })

  it("lets explicit openai options win over the provider's own key", () => {
    const out = toLLMProviderOptions("openai-chat", {
      groq: { reasoningEffort: "low", user: "u" },
      openai: { reasoningEffort: "high" },
    })
    expect(out.openai).toEqual({ reasoningEffort: "high", user: "u" })
  })

  it("keeps routing namespaces out of the OpenAI body options", () => {
    const out = toLLMProviderOptions("openai-chat", { openrouter: { plugins: [] }, gateway: { order: ["a"] } })
    expect(out.openai).toBeUndefined()
    expect(out.openrouter).toEqual({ plugins: [] })
  })

  it("turns the AI SDK's encrypted-reasoning include into the route flag", () => {
    const out = toLLMProviderOptions("openai-responses", { openai: { include: ["reasoning.encrypted_content"] } })
    expect(out.openai?.includeEncryptedReasoning).toBe(true)
  })

  it("exposes Google options to the Gemini route", () => {
    const out = toLLMProviderOptions("gemini", { google: { thinkingConfig: { thinkingBudget: 1024 } } })
    expect(out.gemini).toEqual({ thinkingConfig: { thinkingBudget: 1024 } })
  })

  it("leaves other routes' namespaces alone", () => {
    const options = { anthropic: { thinking: { type: "adaptive" }, effort: "high" } }
    expect(toLLMProviderOptions("anthropic-messages", options)).toEqual(options)
    expect(toLLMProviderOptions("bedrock-converse", { bedrock: { reasoningConfig: {} } })).toEqual({
      bedrock: { reasoningConfig: {} },
    })
  })
})
