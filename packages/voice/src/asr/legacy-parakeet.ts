/**
 * The local model that is gone, and what it left on the user's disk.
 *
 * Parakeet downloaded its weights (up to about 2 GB) into the webview's IndexedDB, database
 * `parakeet-cache-db`. The engine was removed; a cache of a model that can no longer be used is space
 * for nothing, so it is deleted, once, at the first start after the update, with a line in the log.
 * No button and no question: there is nothing to choose, the model cannot be loaded any more.
 *
 * "Once" is a flag in the storage, set when the database is gone (or was never there). A deletion that
 * is blocked by an open connection does not set it, and the next start tries again.
 */

/** The database parakeet.js wrote to. */
export const LEGACY_PARAKEET_DB = "parakeet-cache-db"

/** Set when the legacy cache has been dealt with. */
const DONE_KEY = "nikcli.voice.parakeetCacheDropped"

export interface LegacyParakeetEnv {
  indexedDB?: Pick<IDBFactory, "deleteDatabase"> & { databases?: () => Promise<Array<{ name?: string }>> }
  storage?: Pick<Storage, "getItem" | "setItem">
  log?: (line: string) => void
}

export interface LegacyParakeetResult {
  /** The database was there and has been deleted. */
  dropped: boolean
  /** Nothing was done: the flag says it was dealt with, or there is no storage to look at. */
  skipped: boolean
}

function defaults(): LegacyParakeetEnv {
  return {
    indexedDB: typeof indexedDB === "undefined" ? undefined : indexedDB,
    storage: typeof localStorage === "undefined" ? undefined : localStorage,
    log: (line) => console.info(line),
  }
}

const remember = (env: LegacyParakeetEnv) => {
  try {
    env.storage?.setItem(DONE_KEY, "1")
  } catch {
    // Without a flag it runs again next start and finds nothing: harmless.
  }
}

/** Deletes the cached Parakeet model, once. Never throws. */
export async function dropLegacyParakeet(env: LegacyParakeetEnv = defaults()): Promise<LegacyParakeetResult> {
  try {
    if (!env.indexedDB) return { dropped: false, skipped: true }
    if (env.storage?.getItem(DONE_KEY)) return { dropped: false, skipped: true }

    // Where the browser can list its databases, look first: most users never had the model, and for them there is nothing to log.
    if (typeof env.indexedDB.databases === "function") {
      const known = await env.indexedDB.databases()
      if (!known.some((db) => db.name === LEGACY_PARAKEET_DB)) {
        remember(env)
        return { dropped: false, skipped: false }
      }
    }

    const deleted = await new Promise<boolean>((resolve) => {
      const request = env.indexedDB!.deleteDatabase(LEGACY_PARAKEET_DB)
      request.onsuccess = () => resolve(true)
      request.onerror = () => resolve(false)
      request.onblocked = () => resolve(false)
    })
    if (!deleted) return { dropped: false, skipped: false }
    remember(env)
    env.log?.(`voce: rimosso il modello locale Parakeet (${LEGACY_PARAKEET_DB}), non più usato`)
    return { dropped: true, skipped: false }
  } catch {
    return { dropped: false, skipped: false }
  }
}
