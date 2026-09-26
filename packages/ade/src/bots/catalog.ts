/**
 * Whether a bot's nikcli model is free, from nikcli's own catalog (B11
 * review, M2), the way the chat's selector decides it (`chat/model.ts`).
 *
 * The `:free` suffix is not the whole answer: a provider that prices its
 * catalogue honestly (OpenCode Zen, a local server) prices its free models at
 * 0 and names them after the tier, not after a tag. Everywhere else a cost of
 * 0 means the price is missing, not that it is nothing, so only the suffix
 * counts there, and nikcli is not asked.
 */

import { formatModelLabel, hasReliableCost, isFreeModel } from "../chat/model"

export interface CatalogModel {
  readonly id: string
  readonly providerID?: string
  readonly cost?: { readonly input?: number; readonly output?: number }
  /** Its variants, the efforts it takes (`session/llm.ts`): none is an empty list. */
  readonly variants: readonly string[]
}

/**
 * `nikcli models <provider> --verbose`: each model's `provider/id` on a line
 * of its own, then its record as indented JSON closed by `}` at the start of a
 * line. A record that does not read is skipped, never guessed.
 */
export function parseModelCatalog(stdout: string): ReadonlyMap<string, CatalogModel> {
  const models = new Map<string, CatalogModel>()
  const lines = stdout.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i]!.trim()
    if (!/^[^\s/{}]+\/\S+$/.test(name) || lines[i + 1]?.trim() !== "{") continue
    const end = lines.findIndex((line, at) => at > i && line === "}")
    if (end < 0) break
    try {
      const record = JSON.parse(lines.slice(i + 1, end + 1).join("\n")) as Record<string, unknown>
      const cost = record["cost"] as Record<string, unknown> | undefined
      const variants = record["variants"]
      models.set(name, {
        variants: variants && typeof variants === "object" && !Array.isArray(variants) ? Object.keys(variants) : [],
        id: typeof record["id"] === "string" ? record["id"] : name.slice(name.indexOf("/") + 1),
        ...(typeof record["providerID"] === "string" ? { providerID: record["providerID"] } : {}),
        ...(cost && typeof cost === "object"
          ? {
              cost: {
                ...(typeof cost["input"] === "number" ? { input: cost["input"] } : {}),
                ...(typeof cost["output"] === "number" ? { output: cost["output"] } : {}),
              },
            }
          : {}),
      })
    } catch {
      // Not a record: the next name starts over.
    }
    i = end
  }
  return models
}

/**
 * Whether `model` (`provider/id`) is free. `load` reads the provider's
 * catalog; it is asked only where a cost of 0 can be believed. A catalog that
 * cannot be read, or does not list the model, makes it paid.
 */
export async function catalogFree(model: string, load: (provider: string) => Promise<string>): Promise<boolean> {
  const name = model.trim()
  if (isFreeModel({ id: name })) return true
  const slash = name.indexOf("/")
  if (slash <= 0) return false
  const provider = name.slice(0, slash)
  if (!hasReliableCost(provider)) return false
  let stdout: string
  try {
    stdout = await load(provider)
  } catch {
    return false
  }
  const entry = parseModelCatalog(stdout).get(name)
  if (!entry) return false
  return isFreeModel({ id: entry.id, providerID: entry.providerID ?? provider, ...(entry.cost ? { cost: entry.cost } : {}) })
}

/**
 * The efforts a nikcli model takes: its variants in nikcli's catalog of its
 * provider, the same ones `GET /config/providers` gives. Undefined when the
 * catalog cannot be read or does not list the model: not knowing.
 */
export async function nikcliModelVariants(
  model: string,
  load: (provider: string) => Promise<string>,
): Promise<readonly string[] | undefined> {
  const name = model.trim()
  const slash = name.indexOf("/")
  if (slash <= 0) return undefined
  try {
    return parseModelCatalog(await load(name.slice(0, slash))).get(name)?.variants
  } catch {
    return undefined
  }
}

/**
 * A model as the bot form's list shows it: a free one marked as the Chat's
 * selector marks it, «(gratis)», any other by its id alone. The list is
 * nikcli's ids with no prices, so the `:free` suffix is what tells; before,
 * the 17 free models sat among 368 paid ones looking the same (prove dal
 * vivo 2).
 */
export function botModelLabel(id: string): string {
  return isFreeModel({ id }) ? formatModelLabel(id, undefined, true) : id
}
