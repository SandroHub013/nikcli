/**
 * Most-recently-used project list.
 *
 * Pure functions over a plain array — no I/O, no signals, no side effects.
 * Serialisation is JSON-based and intentionally tolerant: corrupt or outdated
 * data produces an empty list rather than an exception, so the app always
 * starts even if localStorage was wiped or the schema changed.
 */

export interface RecentEntry {
  root: string
  name: string
  /** Epoch-ms of last access — most recent first. */
  openedAt: number
}

/**
 * Adds (or moves to front) a project in the MRU list.
 * Deduplicates on `root` (case-insensitive, normalised).
 */
export function addRecent(
  list: readonly RecentEntry[],
  entry: Omit<RecentEntry, "openedAt">,
  limit = 20,
): RecentEntry[] {
  const key = entry.root.toLowerCase()
  const next: RecentEntry[] = [
    { root: entry.root, name: entry.name, openedAt: Date.now() },
    ...list.filter((e) => e.root.toLowerCase() !== key),
  ]
  return next.slice(0, limit)
}

/** Removes a project by root (case-insensitive). */
export function removeRecent(
  list: readonly RecentEntry[],
  root: string,
): RecentEntry[] {
  const key = root.toLowerCase()
  return list.filter((e) => e.root.toLowerCase() !== key)
}

/** Serialises the list to a JSON string. */
export function serializeRecents(list: readonly RecentEntry[]): string {
  return JSON.stringify(list)
}

/**
 * Parses a JSON string into a list of recent entries.
 * Returns an empty array on any error — corrupt data must never prevent
 * the app from starting.
 */
export function parseRecents(json: string): RecentEntry[] {
  try {
    const raw = JSON.parse(json)
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (e): e is RecentEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof e.root === "string" &&
        typeof e.name === "string" &&
        typeof e.openedAt === "number",
    )
  } catch {
    return []
  }
}
