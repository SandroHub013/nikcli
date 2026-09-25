/**
 * The chat section's state, as data.
 *
 * Kept apart from the component for the reason every pure module in this
 * package is: a `.tsx` has no automatic JSX runtime under `bun test` here, so
 * anything that lives in the component is untestable by construction. The two
 * things worth asserting — how a streamed response is decoded, and what is
 * sent back as context — are both here, and the component imports them rather
 * than carrying a second copy.
 */

export type ChatRole = "user" | "assistant"

export interface ChatMessage {
  id: string
  role: ChatRole
  text: string
  at: number
  /** Set while the model is still streaming into this message. */
  streaming?: boolean
  /** Why this turn failed, when it did. Replaces the text, never joins it. */
  error?: string
}

export interface ChatState {
  messages: ChatMessage[]
}

export function createChatState(): ChatState {
  return { messages: [] }
}

/**
 * How many past messages travel with a request.
 *
 * A cap rather than the whole conversation, because the context window is
 * paid for by the token and an hour-long chat would quietly get expensive.
 * Pairs, so the window never starts on an assistant turn with no question.
 */
export const MAX_CONTEXT_MESSAGES = 24

/**
 * The messages to send, oldest first, excluding anything that failed.
 *
 * A failed turn is dropped rather than sent as an empty assistant message:
 * an assistant turn with no content is a malformed request on most providers,
 * and on the rest it teaches the model that saying nothing is a valid answer.
 */
export function messagesForRequest(
  messages: readonly ChatMessage[],
  max: number = MAX_CONTEXT_MESSAGES,
): { role: ChatRole; content: string }[] {
  const usable = messages.filter((message) => !message.error && message.text.trim().length > 0)
  const windowed = usable.slice(Math.max(0, usable.length - max))
  return windowed.map((message) => ({ role: message.role, content: message.text }))
}

/** A title for the conversation, taken from its first question. */
export function conversationTitle(messages: readonly ChatMessage[], max = 48): string {
  const first = messages.find((message) => message.role === "user" && message.text.trim())
  if (!first) return "Nuova conversazione"
  const text = first.text.trim().replace(/\s+/g, " ")
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// ---------------------------------------------------------------------------
// Decoding the stream
// ---------------------------------------------------------------------------

export interface SseScan {
  /** Text fragments decoded from complete events in this buffer. */
  deltas: string[]
  /** What is left over: a partial line that the next chunk completes. */
  rest: string
  /** True once the provider sent its terminator. */
  done: boolean
}

/**
 * Pulls content deltas out of an SSE buffer, leaving any partial line behind.
 *
 * The leftover is the whole point. A network chunk boundary falls wherever
 * TCP puts it, routinely mid-JSON, and a decoder that parses each chunk on its
 * own drops exactly the tokens that straddle a boundary — which looks like a
 * model that occasionally swallows a word, not like a bug.
 *
 * Unparseable events are skipped rather than thrown: OpenRouter interleaves
 * comment lines and keep-alives, and one of those must not end a reply that
 * was streaming fine.
 */
export function scanSse(buffer: string): SseScan {
  const deltas: string[] = []
  let done = false

  // Only complete lines are consumed; the tail after the last newline stays.
  const lastBreak = buffer.lastIndexOf("\n")
  if (lastBreak === -1) return { deltas, rest: buffer, done }

  const complete = buffer.slice(0, lastBreak)
  const rest = buffer.slice(lastBreak + 1)

  for (const rawLine of complete.split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith(":")) continue
    if (!line.startsWith("data:")) continue

    const payload = line.slice(5).trim()
    if (payload === "[DONE]") {
      done = true
      continue
    }

    try {
      const parsed = JSON.parse(payload) as {
        choices?: { delta?: { content?: unknown } }[]
      }
      const content = parsed.choices?.[0]?.delta?.content
      if (typeof content === "string" && content.length > 0) deltas.push(content)
    } catch {
      // A keep-alive, a comment, or a provider-specific frame. Not our turn.
    }
  }

  return { deltas, rest, done }
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export function appendMessage(state: ChatState, message: ChatMessage): ChatState {
  return { messages: [...state.messages, message] }
}

export function updateMessage(state: ChatState, id: string, change: (message: ChatMessage) => ChatMessage): ChatState {
  return {
    messages: state.messages.map((message) => (message.id === id ? change(message) : message)),
  }
}

/** Adds a delta to the message being streamed. */
export function appendDelta(state: ChatState, id: string, delta: string): ChatState {
  return updateMessage(state, id, (message) => ({ ...message, text: message.text + delta }))
}

/**
 * Ends a streaming message, as a success or as a failure.
 *
 * A failure that arrives after some text has already streamed keeps that text
 * and carries the error beside it: half an answer plus "la connessione si è
 * interrotta" is more useful than either alone, and discarding what arrived
 * would make a flaky network look like a model that refuses.
 */
export function settleMessage(state: ChatState, id: string, error?: string): ChatState {
  return updateMessage(state, id, (message) => ({
    ...message,
    streaming: false,
    ...(error ? { error } : {}),
  }))
}

// ---------------------------------------------------------------------------
// Models and Agents resolution (C3)
// ---------------------------------------------------------------------------

import type { ProviderList, Agent } from "@nikcli-ai/sdk/client"

export interface ChatModelChoice {
  readonly id: string
  readonly providerID: string
  readonly name: string
  readonly providerName: string
  readonly free: boolean
  readonly cost?: { readonly input: number; readonly output: number }
  readonly label: string
}

export interface ChatAgentChoice {
  readonly name: string
  readonly description?: string
}

/** Whether a model is free of charge (id ends with :free or both input and output costs are 0 numbers). */
export function isFreeModel(model: {
  readonly id: string
  readonly providerID?: string
  readonly cost?: { readonly input?: number; readonly output?: number }
}): boolean {
  if (model.id.endsWith(":free")) return true
  if (
    model.cost !== undefined &&
    typeof model.cost.input === "number" &&
    typeof model.cost.output === "number" &&
    model.cost.input === 0 &&
    model.cost.output === 0
  ) {
    return true
  }
  return false
}

/** Format price in $/M tokens or "gratis" / "free" label. */
export function formatModelPrice(
  cost?: { readonly input: number; readonly output: number },
  free?: boolean,
  lang: "it" | "en" = "it",
): string {
  if (free || !cost || (cost.input === 0 && cost.output === 0)) {
    return lang === "en" ? "free" : "gratis"
  }
  if (cost.input === cost.output) {
    return `$${cost.input}/M`
  }
  return `$${cost.input}/$${cost.output} /M`
}

/** Formatted model label for the dropdown selector. */
export function formatModelLabel(
  name: string,
  cost?: { readonly input: number; readonly output: number },
  free?: boolean,
  lang: "it" | "en" = "it",
): string {
  const price = formatModelPrice(cost, free, lang)
  return `${name} (${price})`
}

export interface ModelListOptions {
  /** If true, returns only free models (ADE Test requirement). */
  readonly isTest?: boolean
  /** Language for price label ("gratis" vs "free"). Defaults to "it". */
  readonly lang?: "it" | "en"
}

export const DEFAULT_FALLBACK_MODEL = "google/gemini-2.5-flash:free"
export const DEFAULT_FALLBACK_AGENT = "assistant"

/** Fallback model choices when offline or before the provider list arrives. */
export function fallbackModels(isTest?: boolean, lang: "it" | "en" = "it"): readonly ChatModelChoice[] {
  const freeModels: ChatModelChoice[] = [
    {
      id: "google/gemini-2.5-flash:free",
      providerID: "nikcli",
      name: "Gemini 2.5 Flash",
      providerName: "Google",
      free: true,
      cost: { input: 0, output: 0 },
      label: formatModelLabel("Gemini 2.5 Flash", { input: 0, output: 0 }, true, lang),
    },
    {
      id: "meta-llama/llama-3.3-70b-instruct:free",
      providerID: "nikcli",
      name: "Llama 3.3 70B",
      providerName: "Meta",
      free: true,
      cost: { input: 0, output: 0 },
      label: formatModelLabel("Llama 3.3 70B", { input: 0, output: 0 }, true, lang),
    },
    {
      id: "qwen/qwen-2.5-coder-32b-instruct:free",
      providerID: "nikcli",
      name: "Qwen 2.5 Coder 32B",
      providerName: "Qwen",
      free: true,
      cost: { input: 0, output: 0 },
      label: formatModelLabel("Qwen 2.5 Coder 32B", { input: 0, output: 0 }, true, lang),
    },
  ]

  if (isTest) return freeModels

  return [
    ...freeModels,
    {
      id: "anthropic/claude-sonnet-4.5",
      providerID: "anthropic",
      name: "Claude Sonnet 4.5",
      providerName: "Anthropic",
      free: false,
      cost: { input: 3, output: 15 },
      label: formatModelLabel("Claude Sonnet 4.5", { input: 3, output: 15 }, false, lang),
    },
    {
      id: "openai/gpt-5",
      providerID: "openai",
      name: "GPT-5",
      providerName: "OpenAI",
      free: false,
      cost: { input: 2.5, output: 10 },
      label: formatModelLabel("GPT-5", { input: 2.5, output: 10 }, false, lang),
    },
  ]
}

export const FALLBACK_AGENTS: readonly ChatAgentChoice[] = [
  { name: "assistant", description: "Default assistant" },
]

/**
 * Extracts and filters selectable models from `provider.list`.
 * In ADE Test (`options.isTest === true`), only free models are included.
 */
export function modelsFromProviderList(
  providerList?: ProviderList | null,
  options?: ModelListOptions,
): readonly ChatModelChoice[] {
  if (!providerList || !Array.isArray(providerList.all)) {
    return fallbackModels(options?.isTest, options?.lang)
  }

  const isTest = options?.isTest ?? false
  const lang = options?.lang ?? "it"
  const result: ChatModelChoice[] = []

  for (const provider of providerList.all) {
    if (!provider || !provider.models) continue
    for (const [id, model] of Object.entries(provider.models)) {
      if (!model || model.status === "deprecated") continue
      const modelId = model.id || id
      const providerId = model.providerID || provider.id
      const free = isFreeModel({ id: modelId, providerID: providerId, cost: model.cost })

      // In ADE Test: only free models are allowed!
      if (isTest && !free) continue

      const cost =
        model.cost && typeof model.cost.input === "number" && typeof model.cost.output === "number"
          ? { input: model.cost.input, output: model.cost.output }
          : undefined

      result.push({
        id: modelId,
        providerID: providerId,
        name: model.name || modelId,
        providerName: provider.name || providerId,
        free,
        cost,
        label: formatModelLabel(model.name || modelId, cost, free, lang),
      })
    }
  }

  if (result.length === 0) {
    return fallbackModels(isTest, lang)
  }

  return result
}

/**
 * Resolves the default model.
 * In ADE Test: ALWAYS a free model, never paid!
 * In normal mode: nikcli's default model (never server's paid default like OpenRouter).
 */
export function defaultModelChoice(
  models: readonly ChatModelChoice[],
  providerList?: ProviderList | null,
  options?: { isTest?: boolean },
): ChatModelChoice | undefined {
  if (models.length === 0) return undefined

  const isTest = options?.isTest ?? false

  if (isTest) {
    // In ADE Test: default is NEVER paid!
    const nikcliFree = models.find((m) => m.providerID === "nikcli" && m.free)
    if (nikcliFree) return nikcliFree
    const anyFree = models.find((m) => m.free)
    if (anyFree) return anyFree
    return models[0]
  }

  // Normal mode: prefer nikcli's default model, NOT the server default (which might be paid OpenRouter)
  const nikcliDefaultId = providerList?.default?.["nikcli"]
  if (nikcliDefaultId) {
    const match = models.find((m) => m.id === nikcliDefaultId || `${m.providerID}/${m.id}` === nikcliDefaultId)
    if (match) return match
  }

  const nikcliFree = models.find((m) => m.providerID === "nikcli" && m.free)
  if (nikcliFree) return nikcliFree

  const anyNikcli = models.find((m) => m.providerID === "nikcli")
  if (anyNikcli) return anyNikcli

  const firstFree = models.find((m) => m.free)
  if (firstFree) return firstFree

  return models[0]
}

/** Extracts selectable agents (excluding subagents and hidden ones). */
export function agentsFromList(
  agents?: readonly (Agent | { name: string; description?: string; mode?: string; hidden?: boolean })[] | null,
): readonly ChatAgentChoice[] {
  if (!agents || agents.length === 0) return FALLBACK_AGENTS

  const filtered = agents
    .filter((a) => {
      if (!a || !a.name) return false
      if (a.mode === "subagent" || a.hidden === true) return false
      return true
    })
    .map((a) => ({
      name: a.name,
      description: a.description,
    }))

  return filtered.length > 0 ? filtered : FALLBACK_AGENTS
}

/** Resolves default agent ("assistant" if available, else first agent). */
export function defaultAgentChoice(agents: readonly ChatAgentChoice[]): string {
  if (agents.length === 0) return DEFAULT_FALLBACK_AGENT
  const assistant = agents.find((a) => a.name === "assistant")
  if (assistant) return assistant.name
  const chat = agents.find((a) => a.name === "chat")
  if (chat) return chat.name
  return agents[0].name
}

/** Detects whether ADE is running as ADE Test. */
export function isAdeTestBuild(): boolean {
  if (typeof document !== "undefined" && document.documentElement?.dataset?.adeBuild === "test") {
    return true
  }
  return false
}

/**
 * Validates a model ID against the available models and test constraints.
 * Rejects paid models under ADE Test identity.
 */
export function validateSelectedModel(
  selectedId: string | null | undefined,
  models: readonly ChatModelChoice[],
  isTest: boolean,
): string | undefined {
  if (!selectedId) return undefined
  const match = models.find((m) => m.id === selectedId)
  if (!match) return undefined
  if (isTest && !match.free) return undefined
  return match.id
}
