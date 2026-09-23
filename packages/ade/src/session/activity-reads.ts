/**
 * The hooked sessions' turn activity, read once per mail pass (P1-C2a).
 *
 * The pass read each pane's `.activity` file with its own invoke, and then
 * `freeNow` read the same file again for every delivery it tried: 4.2 invokes
 * a second with seven panes open. `readAll` takes every file in one call and
 * keeps what it got; `read` answers from that for a second, which is younger
 * than a pass, and reads the file again only after.
 */

export const ACTIVITY_FRESH_MS = 1000

export type ActivityReaders = {
  /** Every nonce in one call, in order; null where there is nothing to read. */
  readMany?: (nonces: string[]) => Promise<(string | null)[]>
  /** One nonce. */
  readOne: (nonce: string) => Promise<string | null>
  now?: () => number
  /** TEMP (P1-C2 A/B): 0 reads every time, as before. */
  freshMs?: number
}

export type ActivityReads = {
  readAll: (nonces: string[]) => Promise<(string | null)[]>
  read: (nonce: string) => Promise<string | null>
}

export function createActivityReads(readers: ActivityReaders): ActivityReads {
  const now = readers.now ?? Date.now
  const kept = new Map<string, { text: string | null; at: number }>()
  const keep = (nonce: string, text: string | null) => {
    kept.set(nonce, { text, at: now() })
    return text
  }
  return {
    async readAll(nonces) {
      if (nonces.length === 0) return []
      const texts = readers.readMany
        ? await readers.readMany(nonces)
        : await Promise.all(nonces.map((nonce) => readers.readOne(nonce)))
      // Only this pass's nonces: a closed pane's entry does not stay behind.
      kept.clear()
      return nonces.map((nonce, i) => keep(nonce, texts[i] ?? null))
    },
    async read(nonce) {
      const last = kept.get(nonce)
      if (last && now() - last.at < (readers.freshMs ?? ACTIVITY_FRESH_MS)) return last.text
      return keep(nonce, await readers.readOne(nonce))
    },
  }
}
