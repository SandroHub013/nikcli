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
