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

import { parseWorkspace, type WorkspaceState } from "./persist"

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
    store.setItem(unreadableKey(key, at), text)
    const all = unreadableCopies(store, key)
    for (const name of all.slice(0, Math.max(0, all.length - MAX_UNREADABLE))) store.removeItem(name)
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
  return { state: undefined, unreadable: true, saveBlocked: !keepUnreadable(store, WORKSPACE_KEY, text, now) }
}
