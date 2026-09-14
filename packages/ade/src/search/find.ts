import type { Host } from "../host/shell"
import { fuzzyMatch } from "../command/match"

export type PathInput = string | { path: string; kind?: "file" | "directory" }

export interface FileHit {
  path: string
  kind?: "file" | "directory"
  /** Punteggio del match sul percorso, per l'ordinamento. */
  score: number
  /** Intervalli da evidenziare nel percorso. */
  ranges: [number, number][]
}

export interface ContentHit {
  path: string
  line: number
  /** La riga intera, tagliata a una lunghezza ragionevole. */
  text: string
  /** Intervalli del match dentro `text`. */
  ranges: [number, number][]
}

const MAX_SNIPPET_LENGTH = 200
const DEFAULT_CONTENT_LIMIT = 500

/**
 * Centers a long line around the first match to keep snippet previews readable.
 * Returns the sliced text (at most 200 chars) and relative highlight ranges.
 */
function trimLine(
  line: string,
  queryLength: number,
  matchIndices: number[],
): { text: string; ranges: [number, number][] } {
  if (line.length <= MAX_SNIPPET_LENGTH) {
    return {
      text: line,
      ranges: matchIndices.map((idx) => [idx, idx + queryLength]),
    }
  }

  const firstMatch = matchIndices[0]
  const matchCenter = firstMatch + Math.floor(queryLength / 2)
  const half = Math.floor(MAX_SNIPPET_LENGTH / 2)
  let start = Math.max(0, matchCenter - half)
  if (start + MAX_SNIPPET_LENGTH > line.length) {
    start = Math.max(0, line.length - MAX_SNIPPET_LENGTH)
  }
  const end = Math.min(line.length, start + MAX_SNIPPET_LENGTH)
  const text = line.slice(start, end)

  const ranges: [number, number][] = []
  for (const idx of matchIndices) {
    const mStart = idx - start
    const mEnd = mStart + queryLength
    if (mStart >= 0 && mEnd <= text.length) {
      ranges.push([mStart, mEnd])
    } else if (mStart >= 0 && mStart < text.length) {
      ranges.push([mStart, text.length])
    }
  }

  return { text, ranges }
}

/**
 * Searches for files by path using fuzzy subsequence matching.
 * Pure and instantaneous over already collected paths.
 */
export function findByName(paths: PathInput[], query: string, limit?: number): FileHit[] {
  const q = query.trim()
  if (q.length === 0) {
    const allHits: FileHit[] = paths.map((item) => {
      const path = typeof item === "string" ? item : item.path
      const kind = typeof item === "object" ? item.kind : (item.endsWith("/") ? "directory" : undefined)
      return {
        path,
        kind,
        score: 0,
        ranges: [],
      }
    })
    return typeof limit === "number" && limit >= 0 ? allHits.slice(0, limit) : allHits
  }

  const lowerQ = q.toLowerCase()
  const hits: FileHit[] = []

  for (const item of paths) {
    const path = typeof item === "string" ? item : item.path
    const kind = typeof item === "object" ? item.kind : (item.endsWith("/") ? "directory" : undefined)
    const cleanPath = path.replace(/[/\\]+$/, "")
    const filename = cleanPath.split(/[/\\]/).pop() || cleanPath
    const lowerFilename = filename.toLowerCase()
    const lowerPath = cleanPath.toLowerCase()

    const fnMatch = fuzzyMatch(q, filename)
    const pathMatch = fuzzyMatch(q, cleanPath)

    if (!fnMatch && !pathMatch) continue

    let score = 0
    let ranges: [number, number][] = []

    // Priority bonuses: exact filename match > filename prefix > filename substring > path substring
    if (lowerFilename === lowerQ) {
      score += 2000
    } else if (lowerFilename.startsWith(lowerQ)) {
      score += 1500
    } else if (lowerFilename.includes(lowerQ)) {
      score += 1000
    } else if (lowerPath.includes(lowerQ)) {
      score += 500
    }

    if (fnMatch) {
      score += fnMatch.score + 200
      const fnOffset = cleanPath.length - filename.length
      ranges = fnMatch.ranges.map(([s, e]) => [s + fnOffset, e + fnOffset])
    } else if (pathMatch) {
      score += pathMatch.score
      ranges = pathMatch.ranges
    }

    hits.push({
      path,
      kind,
      score,
      ranges,
    })
  }

  // Sort descending by score. Native sort is stable for equal scores.
  hits.sort((a, b) => b.score - a.score)

  if (typeof limit === "number" && limit >= 0) {
    return hits.slice(0, limit)
  }
  return hits
}

/**
 * Searches for a literal string inside files, reading them one by one.
 * Skips binary and unreadable files without blocking or failing.
 */
export async function findInFiles(input: {
  host: Host
  paths: string[]
  query: string
  /** Massimo di risultati totali. */
  limit?: number
  /** Byte massimi letti per file: un file enorme non vale il tempo. */
  maxBytes?: number
}): Promise<{ hits: ContentHit[]; truncated: boolean }> {
  const { host, paths, query, limit = DEFAULT_CONTENT_LIMIT, maxBytes } = input

  if (!query || query.length === 0 || !host.readTextFile || limit <= 0) {
    return { hits: [], truncated: false }
  }

  const lowerQuery = query.toLowerCase()
  const hits: ContentHit[] = []
  let truncated = false

  for (const path of paths) {
    let fileRead: { text: string; truncated: boolean; bytes: number }
    try {
      fileRead = await host.readTextFile(path, maxBytes)
    } catch {
      // Skip files that fail to read (unreadable, permissions, binary error, etc.)
      continue
    }

    if (!fileRead || typeof fileRead.text !== "string") {
      continue
    }

    // Skip binary files containing null bytes
    if (fileRead.text.includes("\0")) {
      continue
    }

    const lines = fileRead.text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lowerLine = line.toLowerCase()

      const matchIndices: number[] = []
      let startPos = 0
      while (startPos <= lowerLine.length - lowerQuery.length) {
        const found = lowerLine.indexOf(lowerQuery, startPos)
        if (found === -1) break
        matchIndices.push(found)
        startPos = found + lowerQuery.length
      }

      if (matchIndices.length > 0) {
        const trimmed = trimLine(line, query.length, matchIndices)
        hits.push({
          path,
          line: i + 1,
          text: trimmed.text,
          ranges: trimmed.ranges,
        })

        if (hits.length >= limit) {
          truncated = true
          break
        }
      }
    }

    if (truncated) {
      break
    }
  }

  return { hits, truncated }
}
