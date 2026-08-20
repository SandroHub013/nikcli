/**
 * Reading real worktrees out of git.
 *
 * The parser is separated from the process calls on purpose: `git worktree
 * list --porcelain` has a stable, documented shape, and parsing it is exactly
 * the kind of thing that breaks quietly on an edge case — a detached head, a
 * locked tree, a path with a space. That deserves tests, and tests must not
 * need a repository.
 */
import type { Occupant, Worktree } from "./model"

export interface ParsedTree {
  path: string
  /** Short branch name, or undefined when the tree is detached. */
  branch?: string
  detached: boolean
  locked: boolean
}

/**
 * Parses `git worktree list --porcelain`.
 *
 * The format is one record per tree, records separated by a blank line, each
 * line a key or a key and a value. Unknown keys are ignored rather than
 * refused: git adds attributes over time, and a new one must not blind ADE to
 * every tree that carries it.
 */
export function parseWorktreeList(porcelain: string): ParsedTree[] {
  const trees: ParsedTree[] = []
  let current: ParsedTree | undefined

  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    if (line.trim() === "") {
      if (current) trees.push(current)
      current = undefined
      continue
    }
    const space = line.indexOf(" ")
    const key = space === -1 ? line : line.slice(0, space)
    const value = space === -1 ? "" : line.slice(space + 1)

    if (key === "worktree") {
      current = { path: value, detached: false, locked: false }
      continue
    }
    if (!current) continue
    if (key === "branch") current.branch = shortBranch(value)
    if (key === "detached") current.detached = true
    if (key === "locked") current.locked = true
  }
  if (current) trees.push(current)
  return trees
}

/** `refs/heads/feat/x` reads as `feat/x`; anything else is passed through. */
export function shortBranch(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref
}

/** The last path segment, which is how a tree is named in the interface. */
export function treeName(path: string, projectPath: string): string {
  if (path === projectPath) return "principale"
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/** Counts the lines of `git status --porcelain`: one per modified path. */
export function countDirty(porcelain: string): number {
  return porcelain.split("\n").filter((line) => line.trim().length > 0).length
}

/**
 * Parses `git rev-list --left-right --count <upstream>...HEAD`, which prints
 * two tab-separated numbers: commits only on the upstream, then only on HEAD.
 * A tree with no upstream makes the command fail, and both counts stay zero —
 * "no upstream" is not "up to date", but showing arrows for a comparison that
 * cannot be made would be worse than showing none.
 */
export function parseAheadBehind(output: string): { ahead: number; behind: number } {
  const match = output.trim().match(/^(\d+)\s+(\d+)$/)
  if (!match) return { ahead: 0, behind: 0 }
  return { behind: Number(match[1]), ahead: Number(match[2]) }
}

export function toWorktree(input: {
  parsed: ParsedTree
  projectId: string
  projectPath: string
  dirty: number
  ahead: number
  behind: number
  occupants: Occupant[]
  updatedAt: number
}): Worktree {
  return {
    id: input.parsed.path,
    projectId: input.projectId,
    name: treeName(input.parsed.path, input.projectPath),
    path: input.parsed.path,
    branch: input.parsed.detached ? "(distaccato)" : (input.parsed.branch ?? "(sconosciuto)"),
    ahead: input.ahead,
    behind: input.behind,
    dirty: input.dirty,
    occupants: input.occupants,
    updatedAt: input.updatedAt,
  }
}
