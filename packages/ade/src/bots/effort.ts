/**
 * A nikcli bot's effort, checked against its model's variants.
 *
 * nikcli's efforts are the model's variants, and their names are the model's
 * own: low, medium, high, max, or none at all. A name the model does not have
 * is dropped by nikcli without a word (`session/llm.ts`), and kept on the
 * message as if it had been used: a bot saved with «high» on a model without
 * it ran at the default, and nobody knew (chat-bot-facili, pezzo 0). The
 * variants are the ones `GET /config/providers` gives, after the
 * configuration's overrides, and the check happens before the turn is sent.
 */
import type { ConfigProviders } from "@nikcli-ai/sdk/client"

/**
 * The variants of `providerID/modelID` in the server's configured catalog;
 * undefined when the catalog or the model is not there, which is not knowing.
 * A model without variants gives an empty list.
 */
export function modelVariants(
  providers: ConfigProviders | undefined,
  model: { readonly providerID: string; readonly modelID: string } | undefined,
): readonly string[] | undefined {
  if (!providers || !model) return undefined
  const entry = providers.providers.find((provider) => provider.id === model.providerID)?.models[model.modelID]
  if (!entry) return undefined
  return Object.keys(entry.variants ?? {})
}

/**
 * What a turn sends of the bot's effort, and what it says when it sends none.
 *
 * - No effort: nothing to send.
 * - Variants unknown: sent, and the server decides, as with a model the
 *   catalog could not be read for.
 * - One of the variants: sent.
 * - Anything else: not sent, and the turn says so rather than running at the
 *   default as if it had been used.
 */
export function effortToSend(
  effort: string | undefined,
  variants: readonly string[] | undefined,
): { readonly variant?: string; readonly dropped?: string } {
  const wanted = effort?.trim()
  if (!wanted) return {}
  if (variants === undefined || variants.includes(wanted)) return { variant: wanted }
  return { dropped: wanted }
}

/** What the bot form's effort field offers. */
export interface EffortChoices {
  /** The levels offered after the default. */
  readonly options: readonly string[]
  /** A saved value offered as itself: one that cannot be judged. */
  readonly kept?: string
  /** A saved value the model does not have: the default is shown, and says so. */
  readonly stale?: string
  /** No levels at all: the field is off. */
  readonly none: boolean
}

/**
 * The efforts the form offers. Claude Code's and Codex's are their flags'
 * fixed values, and a value they do not list is theirs to judge. A nikcli
 * bot's are its model's variants and nothing else: a fixed list offered
 * levels a model did not have (`minimal` to `max` for models whose variants
 * are `none` and `thinking`). While the variants are not known (no model
 * pinned, the catalog unread) only the default is offered.
 */
export function effortChoices(input: {
  readonly nikcli: boolean
  readonly fixed: readonly string[]
  readonly variants: readonly string[] | undefined
  readonly saved: string
}): EffortChoices {
  const saved = input.saved.trim()
  if (!input.nikcli) {
    return {
      options: input.fixed,
      ...(saved && !input.fixed.includes(saved) ? { kept: saved } : {}),
      none: input.fixed.length === 0,
    }
  }
  if (input.variants === undefined) return { options: [], ...(saved ? { kept: saved } : {}), none: false }
  if (input.variants.length === 0) return { options: [], ...(saved ? { stale: saved } : {}), none: true }
  return { options: input.variants, ...(saved && !input.variants.includes(saved) ? { stale: saved } : {}), none: false }
}

/**
 * What a save writes of the effort: nothing for one the model does not have.
 * The form showed «predefinito» over it, but a save with nothing touched put
 * the old value back, and every turn said again that it was dropped (review
 * of bot-sforzo, BASSO 2).
 */
export function effortToSave(effort: string, stale: string | undefined): string | undefined {
  const value = effort.trim()
  if (!value || value === stale?.trim()) return undefined
  return value
}
