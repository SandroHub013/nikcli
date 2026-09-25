/**
 * The chat's models and agents, as data (C3).
 *
 * Kept apart from the component for the reason every pure module in this
 * package is: a `.tsx` has no automatic JSX runtime under `bun test` here, so
 * anything that lives in the component is untestable by construction.
 */

import type { ProviderList, Agent } from "@nikcli-ai/sdk/client"
import type { ModelRef } from "./store"
import { t } from "../i18n"

export type { ModelRef }

// ---------------------------------------------------------------------------
// Models and Agents resolution (C3)
// ---------------------------------------------------------------------------

export interface ChatModelChoice {
  readonly id: string
  readonly providerID: string
  readonly modelID: string
  readonly name: string
  readonly providerName: string
  readonly free: boolean
  readonly cost?: { readonly input: number; readonly output: number }
  /** The model's context window, in tokens, when the provider says it. */
  readonly context?: number
  readonly label: string
}

export interface ChatAgentChoice {
  readonly name: string
  readonly description?: string
}

/** Whether two model references point to the exact same provider and model. */
export function sameModel(a?: ModelRef | null, b?: ModelRef | null): boolean {
  if (!a || !b) return false
  return a.providerID === b.providerID && a.modelID === b.modelID
}

/** Serializes a ModelRef to a string key. */
export function serializeModelRef(ref: ModelRef): string {
  return `${ref.providerID}/${ref.modelID}`
}

/** Parses a ModelRef from JSON or slash-delimited string. */
export function parseModelRef(raw?: string | null): ModelRef | undefined {
  if (!raw) return undefined
  try {
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw) as { providerID?: unknown; modelID?: unknown }
      if (typeof parsed?.providerID === "string" && typeof parsed?.modelID === "string") {
        return { providerID: parsed.providerID, modelID: parsed.modelID }
      }
    }
  } catch {}
  const slash = raw.indexOf("/")
  if (slash > 0 && slash < raw.length - 1) {
    return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) }
  }
  return undefined
}

/**
 * Providers that run on the user's own machine, where a cost of 0 means the
 * hardware is already paid for. A hosted provider with a cost of 0 is not free
 * of charge: ElevenLabs and the kilo/* families price most of their catalogue
 * at 0 and bill by characters, credits or a plan instead, which is what put a
 * thousand paid models in the selector labelled free.
 */
const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(["ollama", "lmstudio"])

/**
 * Hosted providers that price their catalogue honestly, so a cost of 0 there
 * is a real price and not a missing one.
 *
 * OpenCode Zen is the one. It serves named third-party models at their public
 * per-token prices — gpt-5.4 at 2.5/15, claude-opus-5-5 at 4/20, gpt-5.4-nano
 * at 0.2/1.25 — and prices its free tier at 0, so 0 there means free. Its free
 * models are named after the tier rather than after a tag, and most do not end
 * in `:free`, so the suffix alone would have thrown them out: space-bunny-free
 * costs nothing, is free, and does not end in a colon.
 */
const RELIABLE_COST_PROVIDERS: ReadonlySet<string> = new Set(["opencode"])

/**
 * Whether a cost of 0 from this provider can be believed, and therefore whether
 * a model that costs nothing to run is free.
 */
function hasReliableCost(providerID: string | undefined): boolean {
  return (
    providerID !== undefined &&
    (LOCAL_PROVIDERS.has(providerID) || RELIABLE_COST_PROVIDERS.has(providerID))
  )
}

/**
 * Whether a model is free of charge: the id ends with :free, or it costs
 * nothing to run and the provider says what its prices mean.
 */
export function isFreeModel(model: {
  readonly id: string
  readonly providerID?: string
  readonly cost?: { readonly input?: number; readonly output?: number }
}): boolean {
  if (model.id.endsWith(":free")) return true
  if (!hasReliableCost(model.providerID)) return false
  return (
    model.cost !== undefined &&
    typeof model.cost.input === "number" &&
    typeof model.cost.output === "number" &&
    model.cost.input === 0 &&
    model.cost.output === 0
  )
}

/**
 * Whether a model can hold a chat: it answers in text and calls tools.
 *
 * A model that says nothing about its capabilities stays in, because a
 * catalogue that does not report them cannot be read as a refusal: dropping
 * those would empty the selector on a server that sends the field only
 * sometimes. One that reports them and fails either test is not a chat model:
 * it cannot answer the Chat, and offering it only produces an empty turn.
 */
function isChatModel(model: {
  readonly capabilities?: {
    readonly toolcall?: boolean
    readonly output?: { readonly text?: boolean }
  }
}): boolean {
  const capabilities = model.capabilities
  if (capabilities === undefined || capabilities === null) return true
  if (capabilities.output !== undefined && capabilities.output.text === false) return false
  if (capabilities.toolcall === false) return false
  return true
}

/**
 * Format price in $/M tokens, or the "gratis" / "free" label.
 *
 * Only `free` says free. A cost of 0 on its own does not, because a hosted
 * provider that prices a model at 0 bills for it some other way and the
 * catalogue is then saying nothing useful: a model whose per-token price is
 * not known gets a dash, which is the honest answer in every language.
 */
export function formatModelPrice(
  cost?: { readonly input: number; readonly output: number },
  free?: boolean,
): string {
  if (free) {
    return t("chat.model.free")
  }
  if (!cost || (cost.input === 0 && cost.output === 0)) {
    return "—"
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
): string {
  const price = formatModelPrice(cost, free)
  return `${name} (${price})`
}

export interface ModelListOptions {
  /** If true, returns only free models (ADE Test requirement). */
  readonly isTest?: boolean
}

/**
 * Extracts and filters selectable models from `provider.list`: the chat
 * models, and in ADE Test (`options.isTest === true`) only the free ones.
 */
export function modelsFromProviderList(
  providerList?: ProviderList | null,
  options?: ModelListOptions,
): readonly ChatModelChoice[] {
  if (!providerList || !Array.isArray(providerList.all)) {
    return []
  }

  const isTest = options?.isTest ?? false
  const result: ChatModelChoice[] = []

  for (const provider of providerList.all) {
    if (!provider || !provider.models) continue
    for (const [id, model] of Object.entries(provider.models)) {
      if (!model || model.status === "deprecated") continue
      // The Chat asks a model for text and for tool calls: a text-to-speech or
      // an image model answers neither, however cheap it is.
      if (!isChatModel(model)) continue
      const modelId = model.id || id
      const providerId = model.providerID || provider.id
      const free = isFreeModel({ id: modelId, providerID: providerId, cost: model.cost })

      // In ADE Test: only free models are allowed.
      if (isTest && !free) continue

      const cost =
        model.cost && typeof model.cost.input === "number" && typeof model.cost.output === "number"
          ? { input: model.cost.input, output: model.cost.output }
          : undefined

      result.push({
        id: modelId,
        providerID: providerId,
        modelID: modelId,
        name: model.name || modelId,
        providerName: provider.name || providerId,
        free,
        cost,
        ...(typeof model.limit?.context === "number" && model.limit.context > 0 ? { context: model.limit.context } : {}),
        label: formatModelLabel(model.name || modelId, cost, free),
      })
    }
  }

  return result
}

/**
 * Resolves the default model choice.
 * Rule: The default is the model from nikcli config (GET /config, field model) IF it is free,
 * otherwise the first free model, otherwise undefined (none: the Chat asks to choose and Send is disabled).
 */
export function defaultModelChoice(
  models: readonly ChatModelChoice[],
  configModel?: ModelRef | string | null,
): ChatModelChoice | undefined {
  if (models.length === 0) return undefined

  if (configModel) {
    if (typeof configModel === "object") {
      const match = models.find((m) => sameModel(m, configModel))
      if (match && match.free) {
        return match
      }
    } else {
      const ref = parseModelRef(configModel)
      if (ref) {
        const match = models.find((m) => sameModel(m, ref))
        if (match && match.free) {
          return match
        }
      }
      const match = models.find(
        (m) =>
          m.id === configModel ||
          m.modelID === configModel ||
          serializeModelRef(m) === configModel ||
          m.name === configModel,
      )
      if (match && match.free) {
        return match
      }
    }
  }

  const firstFree = models.find((m) => m.free)
  if (firstFree) {
    return firstFree
  }

  return undefined
}

/** Extracts selectable agents (excluding subagents and hidden ones). */
export function agentsFromList(
  agents?: readonly (Agent | { name: string; description?: string; mode?: string; hidden?: boolean })[] | null,
): readonly ChatAgentChoice[] {
  if (!agents || agents.length === 0) return []

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

  return filtered
}

/** Resolves default agent ("assistant" if available, else first agent, else undefined). */
export function defaultAgentChoice(agents: readonly ChatAgentChoice[]): string | undefined {
  if (agents.length === 0) return undefined
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
 * Validates a model against the available models and test constraints.
 * Compares by providerID and modelID pair.
 * Rejects paid models under ADE Test identity.
 */
export function validateSelectedModel(
  selected: ModelRef | string | null | undefined,
  models: readonly ChatModelChoice[],
  isTest: boolean,
): ModelRef | undefined {
  if (!selected) return undefined

  if (typeof selected === "object") {
    const match = models.find((m) => sameModel(m, selected))
    if (!match) return undefined
    if (isTest && !match.free) return undefined
    return { providerID: match.providerID, modelID: match.modelID }
  }

  const ref = parseModelRef(selected)
  if (ref) {
    const match = models.find((m) => sameModel(m, ref))
    if (match) {
      if (isTest && !match.free) return undefined
      return { providerID: match.providerID, modelID: match.modelID }
    }
  }

  const match = models.find(
    (m) =>
      m.id === selected ||
      m.modelID === selected ||
      serializeModelRef(m) === selected,
  )
  if (match) {
    if (isTest && !match.free) return undefined
    return { providerID: match.providerID, modelID: match.modelID }
  }

  return undefined
}
