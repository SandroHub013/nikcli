/**
 * The keys `localStorage` held while the world was still called NikVerse (`ade.nikverse.*`). The new ones are `ade.raguverse.*`:
 * the first read that finds the new key empty takes what the old one holds and writes it under the new one, and from then on the old
 * one is never looked at again (it is left where it is, so a build from before the rename still finds its own).
 */

export interface KeyStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const LEGACY_LOWERED_KEY = "ade.nikverse.lowered"
export const LEGACY_PLAYER_KEY = "ade.nikverse.player"

/** What is under `key`; if nothing is, what is under `legacy`, copied to `key` on the way. */
export function readCopyingLegacy(storage: KeyStorage | undefined, key: string, legacy: string): string | null {
  const current = storage?.getItem(key) ?? null
  if (current !== null) return current
  const old = storage?.getItem(legacy) ?? null
  if (old === null) return null
  try {
    storage?.setItem(key, old)
  } catch {
    /* the copy is a convenience: what was read is still good for this session */
  }
  return old
}
