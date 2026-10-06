/**
 * The project's file list, walked once and kept.
 *
 * Walking a repository costs seconds; doing it on every keystroke would make the search box unusable on exactly the
 * projects where search matters. The list is read on the first query and reused until the project changes — or until it
 * is old enough that files created since would be missing. A stale list still answers at once; the fresh one replaces it
 * for the next keystroke.
 *
 * Apart from `workbench.tsx` so that it can be tested: a walk that is still running when the project changes must not
 * answer for the new one (full review 2026-10-06, sessions 18).
 */

export interface WalkedEntry {
  readonly path: string
  readonly kind: "file" | "directory"
}

export interface Walked {
  readonly root: string
  readonly at: number
  readonly entries: readonly WalkedEntry[]
}

export const WALK_FRESH_MS = 30_000

export function createProjectWalk(deps: {
  walk: (root: string) => Promise<readonly WalkedEntry[]>
  now?: () => number
  freshMs?: number
}): (root: string) => Promise<readonly WalkedEntry[]> {
  const now = deps.now ?? Date.now
  const freshMs = deps.freshMs ?? WALK_FRESH_MS
  let walked: Walked | undefined
  let walking: { root: string; promise: Promise<Walked> } | undefined

  return async (root) => {
    const sameRoot = walked?.root === root
    if (!sameRoot || now() - walked!.at > freshMs) {
      // A walk of another project that is still running is not this one's: the answer would be its files under this root.
      if (!walking || walking.root !== root) {
        const mine: { root: string; promise: Promise<Walked> } = {
          root,
          promise: deps.walk(root).then((entries) => {
            const entry: Walked = { root, at: now(), entries }
            // Only the walk that is current may keep its result: a late one would put an older project over a newer list.
            if (walking === mine) {
              walked = entry
              walking = undefined
            }
            return entry
          }),
        }
        walking = mine
        // A stale list answers without waiting for it: its failure must not be an unhandled rejection of nobody's.
        mine.promise.catch(() => {
          if (walking === mine) walking = undefined
        })
      }
      // Only a different project has to wait; a merely old list answers now.
      if (!sameRoot) return (await walking.promise).entries
    }
    return walked?.root === root ? walked.entries : []
  }
}
