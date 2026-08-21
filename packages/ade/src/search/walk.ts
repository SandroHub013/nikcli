import type { Host, DirEntry } from "../host/shell"
import { normalizePath, joinPath } from "../host/path"

/**
 * Directories skipped by default during project traversal.
 * Heavy build artifacts, metadata, and dependencies that should not clutter search.
 */
export const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".ade-trees",
  ".next",
  ".turbo",
  "coverage",
])

export const DEFAULT_WALK_LIMIT = 20_000

export interface WalkOptions {
  /** Directory da non aprire mai. */
  skipDirs?: ReadonlySet<string>
  /** Numero massimo di file da restituire prima di fermarsi. */
  limit?: number
  /** Profondità massima, contando la radice come 0. */
  maxDepth?: number
}

export interface WalkResult {
  files: string[]
  /** Vero quando la camminata si è fermata per un limite, non perché finita. */
  stopped: boolean
}

/**
 * Traverses a project directory tree in breadth-first order (BFS).
 * Files close to the root are discovered first as they are most frequently targeted.
 */
export async function walkProject(input: {
  host: Host
  root: string
  options?: WalkOptions
}): Promise<WalkResult> {
  const host = input.host
  if (!host.readDir) {
    return { files: [], stopped: false }
  }

  const root = normalizePath(input.root)
  const skipDirs = input.options?.skipDirs ?? DEFAULT_SKIP_DIRS
  const limit = input.options?.limit ?? DEFAULT_WALK_LIMIT
  const maxDepth = input.options?.maxDepth

  if (limit <= 0) {
    return { files: [], stopped: true }
  }

  const files: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]

  while (queue.length > 0) {
    const current = queue.shift()!

    let entries: DirEntry[]
    try {
      entries = await host.readDir(current.dir)
    } catch {
      // Individual directory read errors (permissions, broken symlinks) are skipped gracefully
      continue
    }

    if (!Array.isArray(entries)) {
      continue
    }

    // Sort entries alphabetically by name for deterministic traversal order
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
    const subdirs: string[] = []

    for (const entry of sorted) {
      if (entry.is_dir) {
        if (!skipDirs.has(entry.name)) {
          const dirPath = entry.path ? normalizePath(entry.path) : joinPath(current.dir, entry.name)
          subdirs.push(dirPath)
        }
      } else {
        const filePath = entry.path ? normalizePath(entry.path) : joinPath(current.dir, entry.name)
        files.push(filePath)
        if (files.length >= limit) {
          return { files, stopped: true }
        }
      }
    }

    // Enqueue subdirectories if depth limit has not been reached
    if (maxDepth === undefined || current.depth < maxDepth) {
      for (const subdir of subdirs) {
        queue.push({ dir: subdir, depth: current.depth + 1 })
      }
    }
  }

  return { files, stopped: false }
}
