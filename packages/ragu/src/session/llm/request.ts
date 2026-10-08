/**
 * Request utilities for @ragu/llm integration.
 * These helpers convert between AI SDK data shapes and @ragu/llm's canonical forms.
 */
import type { ModelMessage } from "@/session/llm/types"

// Check if messages contain any tool-call content
export function hasToolCalls(messages: readonly ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if ((part as any).type === "tool-call" || (part as any).type === "tool-result") return true
    }
  }
  return false
}

export * as LLMRequest from "./request"
