/**
 * Pure data model and risk evaluation for project worktrees.
 *
 * In ADE, multiple autonomous agent sessions can operate across different git worktrees
 * belonging to one or more projects. When two or more active agents target the same worktree,
 * their concurrent filesystem operations, file edits, and git commands will collide and
 * overwrite each other without warning.
 *
 * This module defines the core domain types and pure functions to compute worktree risk,
 * identify active conflicts, and order worktrees for the board view.
 */

export interface Occupant {
  sessionId: string
  agentId: string // "agy", "kimi", …
  state: "working" | "waiting" | "stopped"
}

export interface Worktree {
  id: string
  projectId: string
  /** Display name; the primary tree of a project is conventionally "principale". */
  name: string
  path: string
  branch: string
  /** Commits ahead of / behind its upstream. */
  ahead: number
  behind: number
  /** Files modified in the working tree. 0 means clean. */
  dirty: number
  occupants: Occupant[]
  /** Last activity, epoch milliseconds. Passed in — never read the clock here. */
  updatedAt: number
}

export type Risk = "conflitto" | "occupato" | "libero"

/**
 * Whether an occupant is actively holding the worktree.
 *
 * Design Decision on Stopped Occupants:
 * A "stopped" occupant does NOT count as holding the worktree.
 *
 * Rationale:
 * - A "working" agent is actively issuing tool calls, editing files, or running commands.
 * - A "waiting" agent has an open, active session poised to resume execution upon user input
 *   or tool completion, retaining its in-memory context and working tree association.
 * - A "stopped" agent has terminated its process. It performs no disk I/O, holds no file
 *   locks, and cannot race against or overwrite concurrent file edits.
 *
 * Treating stopped occupants as holding the tree would cause two severe failure modes:
 * 1. An idle tree with only a stopped session would be classified as "occupato" instead of
 *    "libero", falsely blocking relocation of conflicted agents into a genuinely usable tree.
 * 2. A tree where a new agent begins work after a previous agent stopped would trigger a
 *    false "conflitto" alert and prompt an unnecessary relocation for a dead session.
 *
 * Therefore, only "working" and "waiting" occupants actively hold the tree.
 */
export function isHolding(occupant: Occupant): boolean {
  return occupant.state === "working" || occupant.state === "waiting"
}

/**
 * Evaluates the risk status of a worktree based on active occupancy.
 *
 * - `conflitto`: More than one occupant is actively holding the tree (working or waiting).
 *   Requires immediate user intervention or automated relocation to prevent data loss.
 * - `occupato`: Exactly one occupant is actively holding the tree. Normal operating state.
 * - `libero`: No occupants are actively holding the tree. Safe for new or relocated sessions.
 */
export function riskOf(tree: Worktree): Risk {
  const activeCount = tree.occupants.filter(isHolding).length
  if (activeCount > 1) return "conflitto"
  if (activeCount === 1) return "occupato"
  return "libero"
}

/**
 * Priority rank for risk states. Lower numbers sort first.
 */
const RISK_PRIORITY: Record<Risk, number> = {
  conflitto: 0,
  occupato: 1,
  libero: 2,
}

/**
 * Orders worktrees for display on the worktree board so that trees requiring
 * attention appear at the top.
 *
 * Ordering Strategy:
 * 1. Risk Level (`conflitto` > `occupato` > `libero`):
 *    A worktree in conflict represents an immediate danger of file corruption from
 *    colliding agents and demands the highest visual priority so the user sees the
 *    conflict banner and relocation action immediately. Active occupied trees come next,
 *    while free trees sit at the bottom as available capacity.
 * 2. Uncommitted Modifications (`dirty` descending):
 *    Among trees in the same risk tier, worktrees with dirty working copies have
 *    uncommitted changes at stake and require closer monitoring than clean trees.
 * 3. Recency of Activity (`updatedAt` descending):
 *    Recently active worktrees represent current user focus and active agent turns,
 *    and should appear ahead of stale trees.
 * 4. Display Name (`name` ascending):
 *    Deterministic alphabetical tie-breaker ensuring a stable layout across re-renders.
 *
 * This function is pure and returns a new sorted array without mutating the input.
 */
export function sortForBoard(trees: Worktree[]): Worktree[] {
  return [...trees].sort((a, b) => {
    const riskDiff = RISK_PRIORITY[riskOf(a)] - RISK_PRIORITY[riskOf(b)]
    if (riskDiff !== 0) return riskDiff

    const dirtyDiff = b.dirty - a.dirty
    if (dirtyDiff !== 0) return dirtyDiff

    const timeDiff = b.updatedAt - a.updatedAt
    if (timeDiff !== 0) return timeDiff

    return a.name.localeCompare(b.name)
  })
}

/**
 * Returns all worktrees currently experiencing an active occupancy conflict.
 */
export function conflicts(trees: Worktree[]): Worktree[] {
  return trees.filter((tree) => riskOf(tree) === "conflitto")
}
