/**
 * A saved workspace that cannot be read is kept, not replaced.
 *
 * `parseWorkspace` answers `undefined` for damaged JSON and for a `version`
 * newer than this build knows (the user rolled back to an older release). The
 * boot then starts empty and the autosave wrote that empty workbench over
 * `ade.workspace` about a second later: every saved session, resume id and
 * worktree link gone, and going forward again did not bring them back.
 *
 * So before anything can write, the text is copied to
 * `ade.workspace.unreadable.<timestamp>`. Only the newest `MAX_UNREADABLE`
 * copies are kept. When the copy cannot be made (storage full) the caller must
 * not save over the original: `keepUnreadable` says so by returning `false`.
 */

import { parseWorkspace, unreadableReason, type WorkspaceState } from "./persist"

/** The storage the copies go to: the part of `Storage` this file uses. */
export interface UnreadableStore {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** How many unreadable copies stay; older ones are dropped. */
export const MAX_UNREADABLE = 3

/** The key a copy of `key` is kept under at `at`. */
export const unreadableKey = (key: string, at: number): string => `${key}.unreadable.${at}`

/** The keys of the copies of `key`, oldest first. */
export function unreadableCopies(store: UnreadableStore, key: string): string[] {
  const prefix = `${key}.unreadable.`
  const found: { name: string; at: number }[] = []
  for (let i = 0; i < store.length; i++) {
    const name = store.key(i)
    if (name === null || !name.startsWith(prefix)) continue
    const at = Number(name.slice(prefix.length))
    if (Number.isFinite(at)) found.push({ name, at })
  }
  return found.sort((a, b) => a.at - b.at).map((one) => one.name)
}

/**
 * Makes sure `text`, the saved value of `key` that did not parse, has a copy.
 *
 * Returns `true` when a copy of exactly this text exists afterwards (one made
 * now, or one a previous start already made), `false` when it could not be
 * made. The same text is never copied twice, so a start that cannot read the
 * save and is closed again does not fill the quota with duplicates.
 */
export function keepUnreadable(store: UnreadableStore, key: string, text: string, now: number): boolean {
  try {
    const existing = unreadableCopies(store, key)
    if (existing.some((name) => store.getItem(name) === text)) return true
    // Never go backwards: two copies in the same millisecond or a clock set back would overwrite or misorder.
    const last = existing.length ? Number(existing[existing.length - 1]!.slice(key.length + ".unreadable.".length)) : 0
    const at = Math.max(now, last + 1)
    // Room first: the oldest go before the new one is written, down to what leaves space for it. The unread text stays
    // in `key` if the write fails, so dropping an old copy cannot lose anything that is not still there.
    for (const name of existing.slice(0, Math.max(0, existing.length - (MAX_UNREADABLE - 1)))) store.removeItem(name)
    try {
      store.setItem(unreadableKey(key, at), text)
    } catch {
      // Still no room: the other old copies go too, and it is tried once more.
      for (const name of unreadableCopies(store, key)) store.removeItem(name)
      store.setItem(unreadableKey(key, at), text)
    }
    return true
  } catch {
    return false
  }
}

/** What the boot learns from the saved workspace. */
export interface SavedWorkspace {
  /** The workspace to restore; `undefined` when there is none or it cannot be read. */
  state: WorkspaceState | undefined
  /** The saved text exists and did not parse: the bell tells the user. */
  unreadable: boolean
  /** Why it did not parse: a newer version (updating helps) or damage (it does not). Set with `unreadable`. */
  reason?: "newer" | "broken"
  /** The key its copy is kept under, when there is one: the user is told where it is. */
  copyKey?: string
  /** The unreadable text has no copy: the autosave must not write over it. */
  saveBlocked: boolean
}

/** The key the workspace is saved under. */
export const WORKSPACE_KEY = "ade.workspace"

/**
 * Reads the saved workspace. When the text is there and does not parse, a copy
 * is made before this returns, which is before the autosave can run.
 */
export function readSavedWorkspace(store: UnreadableStore, now: number): SavedWorkspace {
  const text = store.getItem(WORKSPACE_KEY)
  if (!text) return { state: undefined, unreadable: false, saveBlocked: false }
  const state = parseWorkspace(text)
  if (state) return { state, unreadable: false, saveBlocked: false }
  const kept = keepUnreadable(store, WORKSPACE_KEY, text, now)
  const copyKey = kept ? copyOfText(store, WORKSPACE_KEY, text) : undefined
  return {
    state: undefined,
    unreadable: true,
    reason: unreadableReason(text),
    saveBlocked: !kept,
    ...(copyKey ? { copyKey } : {}),
  }
}

/** The newest copy of `key` holding exactly `text`. */
function copyOfText(store: UnreadableStore, key: string, text: string): string | undefined {
  try {
    return unreadableCopies(store, key)
      .reverse()
      .find((name) => store.getItem(name) === text)
  } catch {
    return undefined
  }
}

/**
 * While the autosave is blocked for want of a copy: tries again. `true` when there is nothing left to protect, so the
 * save may go on (the text now reads, is gone, or has its copy).
 */
export function retryUnreadableCopy(store: UnreadableStore, now: number): boolean {
  const text = store.getItem(WORKSPACE_KEY)
  if (!text || parseWorkspace(text)) return true
  return keepUnreadable(store, WORKSPACE_KEY, text, now)
}

/** Where the copies whose offer the user turned down are remembered. Not a copy itself: the copies are not touched. */
export const IGNORED_KEY = "ade.workspace.restore-ignored"

/** The copies the user said «Ignora» to, still kept (an ignored copy that was rotated away is forgotten). */
export function ignoredCopies(store: UnreadableStore): string[] {
  try {
    const raw: unknown = JSON.parse(store.getItem(IGNORED_KEY) ?? "[]")
    const kept = new Set(unreadableCopies(store, WORKSPACE_KEY))
    return Array.isArray(raw) ? raw.filter((key): key is string => typeof key === "string" && kept.has(key)) : []
  } catch {
    return []
  }
}

/** Remembers that the offer for this copy is not wanted. The copy stays until the rotation drops it. */
export function ignoreRestore(store: UnreadableStore, copyKey: string): void {
  try {
    store.setItem(IGNORED_KEY, JSON.stringify([...new Set([...ignoredCopies(store), copyKey])]))
  } catch {
    // Nowhere to remember it: the offer comes back next time, which is all that happens.
  }
}

/** The newest kept copy that this version reads and that has sessions in it, so the bell can offer it back. */
export function restorableCopy(store: UnreadableStore): { key: string; state: WorkspaceState } | undefined {
  const ignored = new Set(ignoredCopies(store))
  for (const key of unreadableCopies(store, WORKSPACE_KEY).reverse()) {
    if (ignored.has(key)) continue
    const text = store.getItem(key)
    const state = text ? parseWorkspace(text) : undefined
    if (state && state.panes.length > 0) return { key, state }
  }
  return undefined
}

/** Puts a kept copy back as the saved workspace, and drops that copy. The caller reloads. */
export function restoreCopy(store: UnreadableStore, copyKey: string): boolean {
  try {
    const text = store.getItem(copyKey)
    if (!text || !parseWorkspace(text)) return false
    store.setItem(WORKSPACE_KEY, text)
    store.removeItem(copyKey)
    return true
  } catch {
    return false
  }
}
