/**
 * The message, tool and stream shapes the session is built on.
 *
 * They follow the AI SDK v5 shapes the session grew up with (`ModelMessage`, `UIMessage`, `Tool`, the
 * `fullStream` event union), so stored sessions, plugins and the processor keep working unchanged, but
 * they are defined here: nothing in nikcli depends on the AI SDK to describe a prompt, a tool or an
 * event. `@nikcli-ai/llm` is the only thing that talks to a provider.
 */
import type { JsonValue } from "@/util/json"

// ── JSON Schema ─────────────────────────────────────────────────────────────

export type JSONSchema7 = {
  [key: string]: unknown
  $schema?: string
  $ref?: string
  type?: string | string[]
  description?: string
  enum?: unknown[]
  const?: unknown
  properties?: { [key: string]: JSONSchema7 | boolean }
  required?: string[]
  items?: JSONSchema7 | JSONSchema7[] | boolean
  additionalProperties?: JSONSchema7 | boolean
  anyOf?: JSONSchema7[]
  oneOf?: JSONSchema7[]
  allOf?: JSONSchema7[]
  format?: string
  default?: unknown
}

export type ProviderMetadata = Record<string, Record<string, JsonValue>>
type ProviderOptions = Record<string, Record<string, JsonValue>>

// ── Model messages ──────────────────────────────────────────────────────────

export type DataContent = string | Uint8Array | ArrayBuffer | Buffer

export type TextPart = { type: "text"; text: string; providerOptions?: ProviderOptions }
export type ImagePart = {
  type: "image"
  image: DataContent | URL
  mediaType?: string
  providerOptions?: ProviderOptions
}
export type FilePart = {
  type: "file"
  data: DataContent | URL
  filename?: string
  mediaType: string
  providerOptions?: ProviderOptions
}
export type ReasoningPart = { type: "reasoning"; text: string; providerOptions?: ProviderOptions }
export type ToolCallPart = {
  type: "tool-call"
  toolCallId: string
  toolName: string
  input: unknown
  providerExecuted?: boolean
  providerOptions?: ProviderOptions
}

export type ToolResultOutput =
  | { type: "text"; value: string }
  | { type: "json"; value: JsonValue }
  | { type: "error-text"; value: string }
  | { type: "error-json"; value: JsonValue }
  | {
      type: "content"
      value: Array<{ type: "text"; text: string } | { type: "media"; data: string; mediaType: string }>
    }

export type ToolResultPart = {
  type: "tool-result"
  toolCallId: string
  toolName: string
  output: ToolResultOutput
  providerOptions?: ProviderOptions
}

export type SystemModelMessage = { role: "system"; content: string; providerOptions?: ProviderOptions }
export type UserModelMessage = {
  role: "user"
  content: string | Array<TextPart | ImagePart | FilePart>
  providerOptions?: ProviderOptions
}
export type AssistantModelMessage = {
  role: "assistant"
  content: string | Array<TextPart | FilePart | ReasoningPart | ToolCallPart | ToolResultPart>
  providerOptions?: ProviderOptions
}
export type ToolModelMessage = { role: "tool"; content: ToolResultPart[]; providerOptions?: ProviderOptions }
export type ModelMessage = SystemModelMessage | UserModelMessage | AssistantModelMessage | ToolModelMessage

const MODEL_ROLES = new Set(["system", "user", "assistant", "tool"])
const PART_TYPES = new Set(["text", "image", "file", "reasoning", "tool-call", "tool-result"])

/**
 * Whether a value is a `ModelMessage` rather than a UI message: a known role carrying `content` that is
 * text or a list of known parts. The session uses this to tell the two shapes apart; it is deliberately
 * not a validator of every field.
 */
export function isModelMessage(value: unknown): value is ModelMessage {
  if (typeof value !== "object" || value === null) return false
  const message = value as { role?: unknown; content?: unknown }
  if (typeof message.role !== "string" || !MODEL_ROLES.has(message.role)) return false
  if (typeof message.content === "string") return message.role !== "tool"
  if (!Array.isArray(message.content)) return false
  return message.content.every(
    (part) =>
      typeof part === "object" && part !== null && PART_TYPES.has((part as { type?: unknown }).type as string),
  )
}

// ── UI messages ─────────────────────────────────────────────────────────────

type ToolState = "input-streaming" | "input-available" | "output-available" | "output-error"

export type UIMessagePart =
  | { type: "text"; text: string; state?: "streaming" | "done"; providerMetadata?: ProviderMetadata }
  | { type: "reasoning"; text: string; state?: "streaming" | "done"; providerMetadata?: ProviderMetadata }
  | { type: "file"; mediaType: string; filename?: string; url: string; providerMetadata?: ProviderMetadata }
  | { type: "step-start" }
  | {
      type: "dynamic-tool"
      toolName: string
      toolCallId: string
      state: ToolState
      input?: unknown
      output?: unknown
      errorText?: string
      callProviderMetadata?: ProviderMetadata
    }
  | {
      type: `tool-${string}`
      toolCallId: string
      state: ToolState
      input?: unknown
      output?: unknown
      rawInput?: unknown
      errorText?: string
      providerExecuted?: boolean
      callProviderMetadata?: ProviderMetadata
    }
  | { type: `data-${string}`; id?: string; data: unknown }

export type UIMessage<METADATA = unknown> = {
  id: string
  role: "system" | "user" | "assistant"
  metadata?: METADATA
  parts: UIMessagePart[]
}

// ── Schemas and tools ───────────────────────────────────────────────────────

export type ValidationResult<T> = { success: true; value: T } | { success: false; error: Error }

/** A JSON Schema with an optional validator: what a tool declares as its input. */
export type Schema<T = unknown> = {
  readonly jsonSchema: JSONSchema7
  readonly validate?: (value: unknown) => ValidationResult<T> | PromiseLike<ValidationResult<T>>
}

export function jsonSchema<T = unknown>(
  schema: JSONSchema7,
  options: { validate?: Schema<T>["validate"] } = {},
): Schema<T> {
  return { jsonSchema: schema, ...(options.validate ? { validate: options.validate } : {}) }
}

/** A tool's input schema as JSON Schema plus validator; absent or unrecognised schemas accept anything. */
export function asSchema(value: unknown): Schema {
  if (typeof value === "object" && value !== null && "jsonSchema" in value) return value as Schema
  return { jsonSchema: { type: "object", properties: {} } }
}

export type ToolExecuteOptions = {
  toolCallId: string
  messages: ModelMessage[]
  abortSignal?: AbortSignal
  experimental_context?: unknown
}
/** The name older code used for the options a tool's `execute` receives. */
export type ToolCallOptions = ToolExecuteOptions

export type Tool<INPUT = any, OUTPUT = any> = {
  id?: string
  type?: "function" | "dynamic"
  description?: string
  inputSchema?: Schema<INPUT>
  providerOptions?: ProviderOptions
  execute?: (input: INPUT, options: ToolExecuteOptions) => OUTPUT | PromiseLike<OUTPUT> | AsyncIterable<OUTPUT>
  toModelOutput?: (output: OUTPUT) => ToolResultOutput
}
export type ToolSet = Record<string, Tool>

/** Declares a tool; the identity function keeps the input/output types of `execute` and `toModelOutput` inferred. */
export function tool<INPUT, OUTPUT>(definition: Tool<INPUT, OUTPUT>): Tool<INPUT, OUTPUT> {
  return definition
}

/** A tool whose schema is only known at runtime (MCP servers, connectors). */
export function dynamicTool(definition: {
  description?: string
  inputSchema: Schema<unknown>
  execute: (input: unknown, options: ToolExecuteOptions) => PromiseLike<unknown> | unknown
}): Tool<unknown, unknown> {
  return { ...definition, type: "dynamic" }
}

// ── Usage and stream events ─────────────────────────────────────────────────

export type LanguageModelUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
}

type FinishReason = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other" | "unknown"

/**
 * What a turn's `fullStream` yields: the events the processor reacts to. A superset is tolerated on
 * the wire (unknown types are ignored), so this lists only what is consumed.
 */
export type StreamEvent =
  | { type: "start" }
  | { type: "start-step"; request?: unknown; warnings?: unknown[] }
  | {
      type: "finish-step"
      finishReason: FinishReason
      usage: LanguageModelUsage
      providerMetadata?: ProviderMetadata
      response?: unknown
    }
  | { type: "finish"; finishReason: FinishReason; totalUsage?: LanguageModelUsage }
  | { type: "text-start"; id: string; providerMetadata?: ProviderMetadata }
  | { type: "text-delta"; id: string; text: string; providerMetadata?: ProviderMetadata }
  | { type: "text-end"; id: string; providerMetadata?: ProviderMetadata }
  | { type: "reasoning-start"; id: string; providerMetadata?: ProviderMetadata }
  | { type: "reasoning-delta"; id: string; text: string; providerMetadata?: ProviderMetadata }
  | { type: "reasoning-end"; id: string; providerMetadata?: ProviderMetadata }
  | { type: "tool-input-start"; id: string; toolName: string; providerMetadata?: ProviderMetadata }
  | { type: "tool-input-delta"; id: string; delta: string; toolName?: string; providerMetadata?: ProviderMetadata }
  | { type: "tool-input-end"; id: string }
  | {
      type: "tool-call"
      toolCallId: string
      toolName: string
      input: unknown
      providerExecuted?: boolean
      providerMetadata?: ProviderMetadata
    }
  | {
      type: "tool-result"
      toolCallId: string
      toolName: string
      input?: unknown
      output: any
      providerExecuted?: boolean
    }
  | { type: "tool-error"; toolCallId: string; toolName: string; input?: unknown; error: unknown }
  | { type: "error"; error: unknown }
  | { type: "abort" }

/** What a turn hands back: the event stream, and the text it produced as a promise. */
export type StreamOutput = {
  fullStream: AsyncIterable<StreamEvent>
  text: Promise<string>
}
