/**
 * UI messages -> model messages.
 *
 * The session stores a conversation as message parts and rebuilds the prompt from them each turn. This
 * is that conversion: a port of the AI SDK's `convertToModelMessages` (v5), which it replaces, with the
 * same grouping rules so stored sessions produce the same prompts as before:
 *
 *  - an assistant message is split into blocks at every `step-start`;
 *  - each block becomes one assistant message plus, when it ran client tools, one tool message holding
 *    their results (provider-executed tools keep their result inside the assistant message);
 *  - a tool call still streaming its input is dropped, and one without an output yields no result.
 */
import type {
  AssistantModelMessage,
  ModelMessage,
  Tool,
  ToolModelMessage,
  ToolResultOutput,
  ToolSet,
  UIMessage,
  UIMessagePart,
  UserModelMessage,
} from "./types"
import type { JsonValue } from "@/util/json"

type ToolPart = Extract<UIMessagePart, { toolCallId: string }>

const isToolPart = (part: UIMessagePart): part is Extract<ToolPart, { type: `tool-${string}` }> =>
  part.type.startsWith("tool-")
const isDynamicToolPart = (part: UIMessagePart): part is Extract<UIMessagePart, { type: "dynamic-tool" }> =>
  part.type === "dynamic-tool"
const isDataPart = (part: UIMessagePart) => part.type.startsWith("data-")

const toolName = (part: Extract<ToolPart, { type: `tool-${string}` }>) => part.type.split("-").slice(1).join("-")

const errorMessage = (error: unknown) => {
  if (error == null) return "unknown error"
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  return JSON.stringify(error)
}

function toolOutput(input: {
  output: unknown
  tool: Tool | undefined
  errorMode: "none" | "text" | "json"
}): ToolResultOutput {
  if (input.errorMode === "text") return { type: "error-text", value: errorMessage(input.output) }
  if (input.errorMode === "json") return { type: "error-json", value: (input.output ?? null) as JsonValue }
  if (input.tool?.toModelOutput) return input.tool.toModelOutput(input.output)
  return typeof input.output === "string"
    ? { type: "text", value: input.output }
    : { type: "json", value: (input.output ?? null) as JsonValue }
}

export function convertToModelMessages(
  messages: UIMessage[],
  options?: { tools?: ToolSet; ignoreIncompleteToolCalls?: boolean },
): ModelMessage[] {
  const out: ModelMessage[] = []

  if (options?.ignoreIncompleteToolCalls) {
    messages = messages.map((message) => ({
      ...message,
      parts: message.parts.filter(
        (part) =>
          !(isToolPart(part) || isDynamicToolPart(part)) ||
          (part.state !== "input-streaming" && part.state !== "input-available"),
      ),
    }))
  }

  for (const message of messages) {
    switch (message.role) {
      case "system": {
        const text = message.parts.filter((part): part is Extract<UIMessagePart, { type: "text" }> => part.type === "text")
        const providerOptions = text.reduce<Record<string, Record<string, JsonValue>>>(
          (acc, part) => (part.providerMetadata ? { ...acc, ...part.providerMetadata } : acc),
          {},
        )
        out.push({
          role: "system",
          content: text.map((part) => part.text).join(""),
          ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
        })
        break
      }

      case "user": {
        const content: UserModelMessage["content"] = []
        for (const part of message.parts) {
          if (part.type === "text") {
            content.push({
              type: "text",
              text: part.text,
              ...(part.providerMetadata ? { providerOptions: part.providerMetadata } : {}),
            })
          } else if (part.type === "file") {
            content.push({
              type: "file",
              mediaType: part.mediaType,
              filename: part.filename,
              data: part.url,
              ...(part.providerMetadata ? { providerOptions: part.providerMetadata } : {}),
            })
          }
        }
        out.push({ role: "user", content })
        break
      }

      case "assistant": {
        let block: UIMessagePart[] = []

        const flush = () => {
          if (block.length === 0) return

          const content: Exclude<AssistantModelMessage["content"], string> = []
          for (const part of block) {
            if (part.type === "text") {
              content.push({
                type: "text",
                text: part.text,
                ...(part.providerMetadata ? { providerOptions: part.providerMetadata } : {}),
              })
            } else if (part.type === "file") {
              content.push({ type: "file", mediaType: part.mediaType, filename: part.filename, data: part.url })
            } else if (part.type === "reasoning") {
              content.push({ type: "reasoning", text: part.text, providerOptions: part.providerMetadata })
            } else if (isDynamicToolPart(part)) {
              if (part.state !== "input-streaming") {
                content.push({
                  type: "tool-call",
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: part.input,
                  ...(part.callProviderMetadata ? { providerOptions: part.callProviderMetadata } : {}),
                })
              }
            } else if (isToolPart(part)) {
              const name = toolName(part)
              if (part.state !== "input-streaming") {
                content.push({
                  type: "tool-call",
                  toolCallId: part.toolCallId,
                  toolName: name,
                  input: part.state === "output-error" ? (part.input ?? part.rawInput) : part.input,
                  providerExecuted: part.providerExecuted,
                  ...(part.callProviderMetadata ? { providerOptions: part.callProviderMetadata } : {}),
                })
                if (part.providerExecuted === true && (part.state === "output-available" || part.state === "output-error")) {
                  content.push({
                    type: "tool-result",
                    toolCallId: part.toolCallId,
                    toolName: name,
                    output: toolOutput({
                      output: part.state === "output-error" ? part.errorText : part.output,
                      tool: options?.tools?.[name],
                      errorMode: part.state === "output-error" ? "json" : "none",
                    }),
                    ...(part.callProviderMetadata ? { providerOptions: part.callProviderMetadata } : {}),
                  })
                }
              }
            }
          }
          out.push({ role: "assistant", content })

          // Client tools: their results go in a message of their own, right after the assistant's.
          const clientTools = block.filter(
            (part): part is Extract<ToolPart, { state: string }> =>
              (isToolPart(part) && part.providerExecuted !== true) || isDynamicToolPart(part),
          )
          if (clientTools.length > 0) {
            const results: ToolModelMessage["content"] = []
            for (const part of clientTools) {
              if (part.state !== "output-error" && part.state !== "output-available") continue
              const name = isDynamicToolPart(part as UIMessagePart)
                ? (part as Extract<UIMessagePart, { type: "dynamic-tool" }>).toolName
                : toolName(part as Extract<ToolPart, { type: `tool-${string}` }>)
              results.push({
                type: "tool-result",
                toolCallId: part.toolCallId,
                toolName: name,
                output: toolOutput({
                  output: part.state === "output-error" ? part.errorText : part.output,
                  tool: options?.tools?.[name],
                  errorMode: part.state === "output-error" ? "text" : "none",
                }),
                ...(part.callProviderMetadata ? { providerOptions: part.callProviderMetadata } : {}),
              })
            }
            out.push({ role: "tool", content: results })
          }
          block = []
        }

        for (const part of message.parts) {
          if (part.type === "text" || part.type === "reasoning" || part.type === "file") block.push(part)
          else if (isToolPart(part) || isDynamicToolPart(part) || isDataPart(part)) block.push(part)
          else if (part.type === "step-start") flush()
        }
        flush()
        break
      }
    }
  }

  return out
}

