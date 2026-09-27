/*
 * The catalog a model chip lists, read when its menu opens and kept for the
 * session (composer-chip, pezzo 2; the conditions of the catalog's review).
 *
 * The bot section used to read it as it mounted, even for a folder not yet
 * known (`createResource(() => projectRoot() ?? "")` loads on ""), so
 * `nikcli models --verbose` ran, 2.6 s and 620 KB, for a user who never
 * opened the menu. A failure used to be kept like a list, an empty one, and
 * said «serve nikcli nel PATH» whatever had happened.
 *
 * Here a read starts on `open`, one per key at a time; a list is kept, a
 * failure is not, and says why.
 */
import type { ChatModelChoice } from "./model"

export type ModelSourceState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly models: readonly ChatModelChoice[] }
  | { readonly kind: "failed"; readonly reason: string }

export type ModelRead =
  | { readonly ok: true; readonly models: readonly ChatModelChoice[] }
  | { readonly ok: false; readonly reason: string }

export interface ModelSource {
  /** The key's catalog: the kept one, the read under way, or a new read. */
  readonly read: (key: string) => Promise<ModelRead>
  /** The kept catalog, without reading. */
  readonly kept: (key: string) => readonly ChatModelChoice[] | undefined
}

export function createModelSource(load: (key: string) => Promise<ModelRead>): ModelSource {
  const done = new Map<string, readonly ChatModelChoice[]>()
  const reading = new Map<string, Promise<ModelRead>>()
  return {
    read: (key) => {
      const kept = done.get(key)
      if (kept) return Promise.resolve({ ok: true, models: kept })
      const under = reading.get(key)
      if (under) return under
      const read = load(key)
        .catch(
          (error: unknown): ModelRead => ({
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
          }),
        )
        .then((result) => {
          // Only a list is kept: the next open reads again after a failure.
          if (result.ok) done.set(key, result.models)
          return result
        })
        .finally(() => reading.delete(key))
      reading.set(key, read)
      return read
    },
    kept: (key) => done.get(key),
  }
}

/** The state a read ends in. */
export function stateOf(read: ModelRead): ModelSourceState {
  return read.ok ? { kind: "ready", models: read.models } : { kind: "failed", reason: read.reason }
}
