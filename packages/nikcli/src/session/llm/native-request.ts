/**
 * AI SDK `ModelMessage` / `Tool` -> `@nikcli-ai/llm` request pieces.
 *
 * The session builds its prompt as AI SDK shapes (`MessageV2.toModelMessages`
 * and `ProviderTransform.message`). The native runtime wants the canonical
 * `@nikcli-ai/llm` schema, so every part the session can produce has to land
 * somewhere. Anything that cannot throws `NativeRequestUnsupported` *before* a
 * request is sent, which `session/llm.ts` turns into a fallback to the AI SDK;
 * a silent drop would instead surface as a provider 400 mid-stream, where no
 * fallback can catch it.
 */
import { asSchema, type ModelMessage, type Tool } from "@/provider/legacy/ai-sdk"
import {
  Message as LLMMessage,
  ToolChoice,
  type ContentPart,
  type ProviderMetadata,
  type ToolDefinition,
} from "@nikcli-ai/llm"
import { isRecord } from "@nikcli-ai/util/record"

export class NativeRequestUnsupported extends Error {
  constructor(readonly reason: string) {
    super(`native request unsupported: ${reason}`)
    this.name = "NativeRequestUnsupported"
  }
}

const unsupported = (reason: string): never => {
  throw new NativeRequestUnsupported(reason)
}

/** AI SDK `providerOptions` on a part/message are the replay metadata the protocols read back. */
function metadata(value: unknown): ProviderMetadata | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, Record<string, unknown>> = {}
  for (const [key, entry] of Object.entries(value)) if (isRecord(entry)) out[key] = entry
  return Object.keys(out).length > 0 ? out : undefined
}

const withMetadata = <const T extends object>(part: T, source: Record<string, unknown>): T => {
  const providerMetadata = metadata(source.providerOptions ?? source.providerMetadata)
  return providerMetadata ? { ...part, providerMetadata } : part
}

type Media = { readonly mediaType: string; readonly data: string | Uint8Array }

/**
 * `@nikcli-ai/llm` media is base64 text or raw bytes. A remote URL has no
 * lowering in any route, so it is refused rather than sent as if it were base64.
 */
function media(value: unknown, mediaType: string | undefined, fallback = "application/octet-stream"): Media {
  if (value instanceof URL) return unsupported(`remote media URL (${value.protocol})`)
  if (value instanceof Uint8Array) return { mediaType: mediaType ?? fallback, data: value }
  if (value instanceof ArrayBuffer) return { mediaType: mediaType ?? fallback, data: new Uint8Array(value) }
  if (typeof value !== "string") return unsupported("media data is not text or bytes")
  const dataURL = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s.exec(value)
  if (dataURL) {
    return { mediaType: mediaType ?? dataURL[1] ?? fallback, data: dataURL[2] }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return unsupported("remote media URL")
  return { mediaType: mediaType ?? fallback, data: value }
}

function userPart(part: unknown): ContentPart {
  if (typeof part === "string") return { type: "text", text: part }
  if (!isRecord(part)) return unsupported("user content part is not an object")
  switch (part.type) {
    case "text":
      return withMetadata({ type: "text", text: String(part.text ?? "") }, part)
    case "image": {
      const mediaType = typeof part.mediaType === "string" ? part.mediaType : undefined
      const resolved = media(part.image, mediaType, "image/png")
      return { type: "media", ...resolved }
    }
    case "file": {
      const mediaType = typeof part.mediaType === "string" ? part.mediaType : undefined
      const resolved = media(part.data, mediaType)
      return {
        type: "media",
        ...resolved,
        ...(typeof part.filename === "string" ? { filename: part.filename } : {}),
      }
    }
    default:
      return unsupported(`user content part "${String(part.type)}"`)
  }
}

function assistantPart(part: unknown): ContentPart | undefined {
  if (typeof part === "string") return { type: "text", text: part }
  if (!isRecord(part)) return unsupported("assistant content part is not an object")
  switch (part.type) {
    case "text":
      return part.text === "" ? undefined : withMetadata({ type: "text", text: String(part.text) }, part)
    case "reasoning":
      return withMetadata({ type: "reasoning", text: String(part.text ?? "") }, part)
    case "tool-call":
      return withMetadata(
        {
          type: "tool-call",
          id: String(part.toolCallId),
          name: String(part.toolName),
          input: part.input,
          ...(part.providerExecuted === true ? { providerExecuted: true } : {}),
        },
        part,
      )
    case "tool-result":
      // A result inside an assistant message is a provider-executed tool (web search, code execution).
      return withMetadata(
        {
          type: "tool-result",
          id: String(part.toolCallId),
          name: String(part.toolName),
          result: toolOutput(part.output),
          providerExecuted: true,
        },
        part,
      )
    default:
      return unsupported(`assistant content part "${String(part.type)}"`)
  }
}

/** AI SDK tool output (`{ type, value }`) -> the three result kinds the protocols lower. */
function toolOutput(output: unknown) {
  if (!isRecord(output) || typeof output.type !== "string") return { type: "json" as const, value: output }
  switch (output.type) {
    case "text":
      return { type: "text" as const, value: output.value }
    case "json":
      return { type: "json" as const, value: output.value }
    case "error-text":
    case "error-json":
      return { type: "error" as const, value: output.value }
    case "content": {
      const items = Array.isArray(output.value) ? output.value : []
      const text: string[] = []
      for (const item of items) {
        if (isRecord(item) && item.type === "text") text.push(String(item.text))
        else return unsupported(`tool result content "${isRecord(item) ? String(item.type) : typeof item}"`)
      }
      return { type: "text" as const, value: text.join("\n") }
    }
    default:
      return unsupported(`tool output "${output.type}"`)
  }
}

function toolPart(part: unknown): ContentPart {
  if (!isRecord(part) || part.type !== "tool-result") return unsupported("tool message part is not a tool-result")
  return withMetadata(
    {
      type: "tool-result",
      id: String(part.toolCallId),
      name: String(part.toolName),
      result: toolOutput(part.output),
    },
    part,
  )
}

/**
 * Convert AI SDK messages into canonical messages.
 *
 * `system` messages are skipped: the request carries its system prompt as
 * `SystemPart`s, so converting them here as well would send it twice.
 * Message-level `providerOptions` ride as `native` (the OpenAI-compatible
 * `reasoning_content` replay reads `native.openaiCompatible`).
 */
export function toLLMMessages(messages: readonly ModelMessage[]): LLMMessage[] {
  const out: LLMMessage[] = []
  for (const message of messages) {
    const native = isRecord(message.providerOptions) ? { native: message.providerOptions } : {}
    switch (message.role) {
      case "system":
        break
      case "user": {
        const content =
          typeof message.content === "string"
            ? message.content === ""
              ? []
              : [{ type: "text" as const, text: message.content }]
            : message.content.map(userPart)
        if (content.length > 0) out.push(LLMMessage.make({ role: "user", content, ...native }))
        break
      }
      case "assistant": {
        const content =
          typeof message.content === "string"
            ? message.content === ""
              ? []
              : [{ type: "text" as const, text: message.content }]
            : message.content.flatMap((part) => assistantPart(part) ?? [])
        if (content.length > 0) out.push(LLMMessage.make({ role: "assistant", content, ...native }))
        break
      }
      case "tool": {
        const content = message.content.map(toolPart)
        if (content.length > 0) out.push(LLMMessage.make({ role: "tool", content, ...native }))
        break
      }
    }
  }
  return out
}

/**
 * AI SDK tools -> canonical definitions. `inputSchema` may be a zod schema or a
 * `jsonSchema()` wrapper; `asSchema` resolves both to plain JSON Schema.
 */
export function toLLMToolDefinitions(tools: Record<string, Tool>, deferred?: ReadonlySet<string>): ToolDefinition[] {
  return Object.entries(tools)
    .filter(([name, tool]) => !!tool.description && !deferred?.has(name))
    .map(([name, tool]) => {
      const schema = tool.inputSchema ? asSchema(tool.inputSchema).jsonSchema : undefined
      return {
        name,
        description: tool.description ?? "",
        inputSchema: isRecord(schema) ? schema : { type: "object", properties: {} },
      }
    }) as ToolDefinition[]
}

export function toLLMToolChoice(choice: "auto" | "required" | "none" | { type: "tool"; toolName: string } | undefined) {
  if (choice === undefined || choice === "auto") return undefined
  if (typeof choice === "string") return ToolChoice.make(choice)
  return ToolChoice.named(choice.toolName)
}

/** Routes whose body is built from `providerOptions.openai`, whatever the AI SDK called the provider. */
const OPENAI_SHAPED_ROUTES = new Set(["openai-responses", "openai-chat", "openai-compatible-chat"])

/**
 * Re-key AI SDK provider options for the route that will read them.
 *
 * `ProviderTransform.providerOptions` files the bag under the AI SDK's key for the provider (`xai`,
 * `groq`, `google`, ...). The native routes read fixed namespaces instead: every OpenAI-shaped route
 * reads `openai`, Gemini reads `gemini`. Left alone, a grok or groq reasoning effort, or a Gemini
 * thinking budget, would be set and then never read. Keys the route already reads are kept as they are.
 */
export function toLLMProviderOptions(
  route: string,
  options: Readonly<Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [key, value] of Object.entries(options)) if (isRecord(value)) out[key] = value

  if (route === "gemini" && out.google) out.gemini = { ...out.google, ...out.gemini }

  if (OPENAI_SHAPED_ROUTES.has(route)) {
    const merged: Record<string, unknown> = {}
    // OpenRouter and gateway namespaces carry their own routing options, not OpenAI body fields.
    for (const [key, bag] of Object.entries(out))
      if (key !== "openai" && key !== "openrouter" && key !== "gateway") Object.assign(merged, bag)
    Object.assign(merged, out.openai)
    // The AI SDK asks for encrypted reasoning with `include`; the route has a flag for it.
    const include = merged.include
    if (Array.isArray(include) && include.includes("reasoning.encrypted_content"))
      merged.includeEncryptedReasoning = true
    if (Object.keys(merged).length > 0) out.openai = merged
  }
  return out
}

export * as LLMNative from "./native-request"
