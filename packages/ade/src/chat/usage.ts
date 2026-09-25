/**
 * What an answer and a session cost (C7), from what nikcli writes on every
 * assistant message: `cost`, in dollars, and `tokens`.
 *
 * Ported from the web app's `session-context-metrics.ts`: a session costs the
 * sum of its answers, and its context is the last answer that used tokens,
 * as a share of the model's window when the catalog knows it. The numbers are
 * the server's; nothing here estimates.
 */

import type { Message } from "@nikcli-ai/sdk/httpapi"
import { locale, t } from "../i18n"

type Assistant = Extract<Message, { role: "assistant" }>

export interface Usage {
  readonly cost: number
  readonly tokens: number
}

export interface SessionUsage {
  readonly cost: number
  /** The context of the last answer that used tokens, if any did. */
  readonly context?: {
    readonly tokens: number
    readonly providerID: string
    readonly modelID: string
  }
}

function isAssistant(message: Message): message is Assistant {
  return message.role === "assistant"
}

function tokensOf(message: Assistant): number {
  const tokens = message.tokens
  if (!tokens) return 0
  if (typeof tokens.total === "number" && tokens.total > 0) return tokens.total
  return tokens.input + tokens.output + tokens.reasoning + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
}

/** An answer's cost and tokens, once it is finished and used any; nothing for a question or an answer still coming. */
export function answerUsage(message: Message): Usage | undefined {
  if (!isAssistant(message) || !message.time?.completed) return undefined
  const tokens = tokensOf(message)
  if (tokens <= 0 && !(message.cost > 0)) return undefined
  return { cost: message.cost ?? 0, tokens }
}

/** A session's cost so far, and its last context. */
export function sessionUsage(messages: readonly Message[]): SessionUsage {
  let cost = 0
  let last: Assistant | undefined
  for (const message of messages) {
    if (!isAssistant(message)) continue
    cost += typeof message.cost === "number" ? message.cost : 0
    if (tokensOf(message) > 0) last = message
  }
  if (!last) return { cost }
  return { cost, context: { tokens: tokensOf(last), providerID: last.providerID, modelID: last.modelID } }
}

/** Dollars, in the language's way; four decimals under a dollar, where a free model's cents live. */
export function formatCost(cost: number): string {
  const small = cost > 0 && cost < 1
  if (small && cost < 0.0001) return `< ${formatCost(0.0001)}`
  return new Intl.NumberFormat(locale(), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: small ? 4 : 2,
  }).format(cost)
}

export function formatTokens(tokens: number): string {
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(tokens)
}

/** The line under an answer. */
export function answerUsageText(usage: Usage): string {
  return t("chat.usage.answer", formatTokens(usage.tokens), formatCost(usage.cost))
}

/** The session's line: its cost, and how full the model's window is when its size is known. */
export function sessionUsageText(usage: SessionUsage, contextLimit?: number): string {
  const cost = formatCost(usage.cost)
  if (!usage.context) return t("chat.usage.session", cost)
  const tokens = formatTokens(usage.context.tokens)
  if (!contextLimit || contextLimit <= 0) return t("chat.usage.sessionContext", cost, tokens)
  const percent = Math.min(100, Math.round((usage.context.tokens / contextLimit) * 100))
  return t("chat.usage.sessionWindow", cost, tokens, percent)
}
