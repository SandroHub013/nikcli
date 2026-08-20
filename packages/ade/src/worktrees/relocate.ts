/**
 * Conflict resolution and relocation planning for project worktrees.
 *
 * When multiple agents occupy the same worktree, their simultaneous edits and git
 * operations will collide. This module evaluates conflicted worktrees and generates an
 * actionable relocation proposal: identifying which agent to move out, finding a suitable
 * free destination tree within the same project, or proposing a legal git branch name
 * for a new worktree when no free tree exists.
 */

import { isHolding, riskOf, type Occupant, type Worktree } from "./model"

export interface RelocationPlan {
  /** The occupant to move out; the tree keeps the other(s). */
  move: Occupant
  /** An existing free tree of the same project to move into, when one exists. */
  into?: Worktree
  /** Branch name to propose when a new tree must be created instead. */
  newBranch?: string
  reason: string // Italian, shown to the user
}

/**
 * Sanitizes an arbitrary string (such as a session ID) into a legal git branch name.
 *
 * Git branch naming rules (git check-ref-format):
 * - No whitespace or control characters
 * - No `~`, `^`, `:`, `?`, `*`, `[`, `]`, `\`, `@{`
 * - No consecutive dots `..`
 * - No consecutive slashes `//`
 * - No leading or trailing slashes `/`, dots `.`, or dashes `-`
 * - Must not end with `.lock`
 */
export function sanitizeBranchName(raw: string): string {
  const sanitized = raw
    .replace(/[\s~^:?*\[\]\\@{}]/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/\/[-.]+/g, "/")
    .replace(/[-.]+\//g, "/")
    .replace(/-{2,}/g, "-")
    .replace(/\.lock$/gi, "")
    .replace(/^[/.-]+/, "")
    .replace(/[/.-]+$/, "")

  return sanitized.length > 0 ? sanitized : "relocated-session"
}

/**
 * Derives a valid git branch name from an occupant's session identifier.
 *
 * Shape chosen: `session/${sanitizedSessionId}`
 *
 * Rationale:
 * Prefixing with `session/` cleanly namespaces agent-spawned branches away from mainline
 * repository branches (such as `main`, `master`, `release/*`), while embedding the
 * sanitized session identifier ensures clear provenance for the developer.
 */
export function deriveBranchName(sessionId: string): string {
  const clean = sanitizeBranchName(sessionId)
  return clean.startsWith("session/") ? clean : `session/${clean}`
}

/**
 * Chooses which occupant to relocate from a conflicted worktree.
 *
 * Selection Rules and Rationale:
 * 1. Prefer moving an occupant that is NOT `working` (i.e. `waiting`):
 *    A waiting agent is idle between turns, awaiting user input or next task. Relocating its
 *    session simply points its working directory to a new path before its next prompt,
 *    causing zero execution interruption. In contrast, relocating a `working` agent would
 *    abort in-flight code generation, shell processes, or tool execution.
 * 2. If all occupants are `working`:
 *    Select the last occupant in the list (the latest joiner). In ADE, occupants are
 *    ordered chronologically by attachment time. The first occupant was established in the
 *    tree first; preserving the primary occupant minimizes disruption to the longest-running
 *    context and maintains worktree continuity.
 */
function selectOccupantToMove(occupants: Occupant[]): Occupant {
  const nonWorking = occupants.find((o) => o.state !== "working")
  if (nonWorking) {
    return nonWorking
  }
  // All are working: pick the latest occupant (last in list)
  return occupants[occupants.length - 1]
}

/**
 * Finds the best existing free tree in the same project to receive a relocated occupant.
 *
 * Rules and Rationale:
 * 1. Same project only:
 *    A free tree from a different project belongs to a completely different repository or
 *    codebase. Relocating an agent into another project would corrupt workspace context.
 * 2. Must be `libero`:
 *    Never propose moving into a tree that is `occupato` or in `conflitto`. Doing so would
 *    merely move or compound the conflict rather than resolving it.
 * 3. Preference among free trees:
 *    Clean trees (`dirty === 0`) are preferred over trees with uncommitted modifications,
 *    followed by most recently updated.
 */
function findDestinationTree(tree: Worktree, allTrees: Worktree[]): Worktree | undefined {
  const candidates = allTrees.filter(
    (candidate) =>
      candidate.projectId === tree.projectId &&
      candidate.id !== tree.id &&
      riskOf(candidate) === "libero",
  )

  if (candidates.length === 0) return undefined

  return candidates.sort((a, b) => {
    // Prefer clean trees first
    if (a.dirty === 0 && b.dirty > 0) return -1
    if (b.dirty === 0 && a.dirty > 0) return 1

    // Then most recently updated
    return b.updatedAt - a.updatedAt
  })[0]
}

/**
 * Generates a relocation plan for a conflicted worktree.
 * Returns `undefined` if the tree is not in conflict or has no active occupants to relocate.
 */
export function planRelocation(input: {
  tree: Worktree
  allTrees: Worktree[]
}): RelocationPlan | undefined {
  if (riskOf(input.tree) !== "conflitto") {
    return undefined
  }

  const activeOccupants = input.tree.occupants.filter(isHolding)
  if (activeOccupants.length < 2) {
    return undefined
  }

  const move = selectOccupantToMove(activeOccupants)
  const into = findDestinationTree(input.tree, input.allTrees)

  if (into) {
    return {
      move,
      into,
      reason: `Due agenti attivi nell'albero '${input.tree.name}'. Sposta ${move.agentId} nell'albero libero '${into.name}'.`,
    }
  }

  const newBranch = deriveBranchName(move.sessionId)
  return {
    move,
    newBranch,
    reason: `Due agenti attivi nell'albero '${input.tree.name}' e nessun albero libero nel progetto. Sposta ${move.agentId} sul nuovo branch '${newBranch}'.`,
  }
}
