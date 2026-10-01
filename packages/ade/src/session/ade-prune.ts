/*
 * What ADE leaves in a project's `.ade/` and takes away again.
 *
 * `.ade/` is the one place ADE writes inside the user's repositories, and it is never in their commits (`.git/info/exclude`). Three of its
 * folders only ever grow, one file per request, and nobody reads them after the week they were made in:
 *
 * - `browser/`: a capture of the browser pane (`<stamp>-<pane>.png`) with the note that goes with it (`<stamp>-<pane>.md`);
 * - `results/`: what a spawned session wrote for its parent;
 * - `design/note/`: the notes made on a design sheet.
 *
 * `browser/` keeps the last `KEEP_CAPTURES`, each capture with both of its files; `results/` and `design/note/` lose what is older than
 * `MAX_AGE_DAYS`. What is the project's memory (`decisions.jsonl`, `design.jsonl`, `memory.md`), what git needs (`.gitignore`) and the
 * previews of the design proposals (`design/<k>/<n>.html`) are not in these folders and are never named here, and a protected name in one
 * of them would not be chosen anyway.
 *
 * Pure, so what is chosen can be tested: it gets the listings and the time, and returns the paths to remove. Doing it is the host's, and the
 * host refuses anything that is not a file of one of these three folders (`ade_prune.rs`).
 */

import type { DirEntry } from "../host/shell"

export const KEEP_CAPTURES = 50
export const MAX_AGE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

/** Never chosen, wherever they are listed: the project's memory and what keeps `.ade/` out of git. */
export const PROTECTED = new Set(["decisions.jsonl", "design.jsonl", "memory.md", ".gitignore"])

export type Listed = Pick<DirEntry, "name" | "path" | "is_dir" | "modified_ms">

export interface Listings {
  /** `.ade/browser/` */
  browser: readonly Listed[]
  /** `.ade/results/` */
  results: readonly Listed[]
  /** `.ade/design/note/` */
  notes: readonly Listed[]
}

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}
const stemOf = (name: string) => {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(0, dot) : name
}
const candidate = (entry: Listed, extensions: readonly string[]) =>
  !entry.is_dir && !PROTECTED.has(entry.name.toLowerCase()) && extensions.includes(extensionOf(entry.name))

/** The captures to drop: all but the newest `keep`, a capture being the files that share a name before the extension. */
export function oldCaptures(entries: readonly Listed[], keep = KEEP_CAPTURES): string[] {
  const captures = new Map<string, { newest: number; paths: string[] }>()
  for (const entry of entries) {
    if (!candidate(entry, ["png", "md"])) continue
    const stem = stemOf(entry.name)
    const known = captures.get(stem) ?? { newest: 0, paths: [] }
    known.newest = Math.max(known.newest, entry.modified_ms)
    known.paths.push(entry.path)
    captures.set(stem, known)
  }
  // Newest first. The name starts with the time it was made (`requestStem`), so it breaks a tie between two made in the same moment.
  const ordered = [...captures.entries()].sort((a, b) => b[1].newest - a[1].newest || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
  return ordered.slice(Math.max(0, keep)).flatMap(([, capture]) => capture.paths)
}

/** The notes older than `maxAgeDays` at `now`: files with the extension, never a folder. */
export function oldFiles(entries: readonly Listed[], now: number, extensions: readonly string[], maxAgeDays = MAX_AGE_DAYS): string[] {
  const cutoff = now - maxAgeDays * DAY_MS
  return entries.filter((entry) => candidate(entry, extensions) && entry.modified_ms > 0 && entry.modified_ms < cutoff).map((entry) => entry.path)
}

/** Everything of the three folders that is to be removed at `now`. */
export function pruneChoices(listings: Listings, now: number): string[] {
  return [
    ...oldCaptures(listings.browser),
    ...oldFiles(listings.results, now, ["md"]),
    ...oldFiles(listings.notes, now, ["md"]),
  ]
}

/** The three folders of a project, as paths: `sep` is the one the project's own path uses. */
export function pruneFolders(root: string): { browser: string; results: string; notes: string } {
  const trimmed = root.replace(/[\\/]+$/, "")
  const sep = trimmed.includes("\\") ? "\\" : "/"
  const ade = `${trimmed}${sep}.ade`
  return { browser: `${ade}${sep}browser`, results: `${ade}${sep}results`, notes: `${ade}${sep}design${sep}note` }
}

/** The part of the host this needs. */
export interface PruneHost {
  readDir?: (path: string) => Promise<Listed[]>
  /** Removes the files; the bytes freed. */
  adePrune?: (paths: string[]) => Promise<number>
}

/** Prunes one project's `.ade/`; the bytes freed (0 when there is nothing to do or the host cannot). Never throws. */
export async function pruneProject(host: PruneHost, root: string, now: number): Promise<number> {
  if (!host.readDir || !host.adePrune) return 0
  try {
    const folders = pruneFolders(root)
    const [browser, results, notes] = await Promise.all(
      [folders.browser, folders.results, folders.notes].map((folder) => host.readDir!(folder).catch(() => [] as Listed[])),
    )
    const paths = pruneChoices({ browser: browser!, results: results!, notes: notes! }, now)
    return paths.length > 0 ? await host.adePrune(paths) : 0
  } catch {
    return 0
  }
}
