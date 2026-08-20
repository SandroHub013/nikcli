/**
 * Pure session worktree allocation and planning.
 *
 * In ADE, each autonomous agent session runs in its own git worktree to isolate
 * file modifications, compiler outputs, and git operations. Without worktree
 * isolation, concurrent agents operating in the same repository directory will
 * overwrite each other's edits.
 *
 * This module decides whether a new session can safely reuse an existing idle
 * worktree or must create a new dedicated worktree checkout.
 */

import { riskOf, type Worktree } from "./model"

export interface TreePlan {
  /** Reuse this existing tree; when absent, create one. */
  reuse?: Worktree
  /** Directory name for the new tree, sibling to the project. */
  directory?: string
  /** Branch to create it on. */
  branch?: string
  /** Why this plan, in Italian, for the pane's first line. */
  reason: string
}

/**
 * Windows reserved device names that cannot be used as directory names or filenames,
 * regardless of file extension (e.g. CON, con.txt, PRN, AUX, NUL, COM1-9, LPT1-9).
 */
const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i

/**
 * True when this name is safe as a git branch.
 *
 * Git ref format rules (git check-ref-format):
 * - Cannot be empty or whitespace-only.
 * - Cannot contain whitespace or ASCII control characters (0-31, 127).
 * - Cannot contain any of: ~ ^ : ? * [ \
 * - Cannot contain the sequence '@{' or be a single '@'.
 * - Cannot contain consecutive dots '..' anywhere.
 * - Cannot start or end with a slash '/'.
 * - Cannot contain consecutive slashes '//'.
 * - Cannot end with '.lock' or a dot '.'.
 * - Slash-separated components cannot start with '.' or end with '.lock' or '.'.
 */
export function isLegalBranch(name: string): boolean {
  if (!name || typeof name !== "string" || name.length === 0) {
    return false
  }

  // Cannot contain whitespace or control characters
  if (/[\s\x00-\x1f\x7f]/.test(name)) {
    return false
  }

  // Cannot contain illegal git ref characters: ~ ^ : ? * [ \
  if (/[~^:?*\[\\]/.test(name)) {
    return false
  }

  // Cannot contain '@{' sequence or be a single '@'
  if (name.includes("@{") || name === "@") {
    return false
  }

  // Cannot contain consecutive dots '..'
  if (name.includes("..")) {
    return false
  }

  // Cannot start or end with a slash '/'
  if (name.startsWith("/") || name.endsWith("/")) {
    return false
  }

  // Cannot contain consecutive slashes '//'
  if (name.includes("//")) {
    return false
  }

  // Cannot end with '.lock' or '.'
  if (name.endsWith(".lock") || name.endsWith(".")) {
    return false
  }

  // Check each slash-separated component
  const components = name.split("/")
  for (const comp of components) {
    if (comp.length === 0) {
      return false
    }
    if (comp.startsWith(".")) {
      return false
    }
    if (comp.endsWith(".lock")) {
      return false
    }
    if (comp.endsWith(".")) {
      return false
    }
  }

  return true
}

/**
 * True when this name is safe as a single directory name on Windows and POSIX.
 *
 * Rules:
 * - Cannot be empty or exceed 255 characters.
 * - Cannot contain Windows forbidden characters: < > : " / \ | ? *
 * - Cannot contain ASCII control characters (0-31, 127).
 * - Cannot end with a dot '.' or a space ' ' (Windows trailing dot/space truncation bug).
 * - Cannot be '.' or '..'.
 * - Cannot be a Windows reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9).
 */
export function isLegalDirectory(name: string): boolean {
  if (!name || typeof name !== "string" || name.length === 0 || name.length > 255) {
    return false
  }

  // Cannot contain Windows forbidden characters: < > : " / \ | ? *
  if (/[<>:"/\\|?*]/.test(name)) {
    return false
  }

  // Cannot contain control characters (ASCII 0-31, 127)
  if (/[\x00-\x1f\x7f]/.test(name)) {
    return false
  }

  // Cannot end with dot or space
  if (name.endsWith(".") || name.endsWith(" ")) {
    return false
  }

  // Cannot be '.' or '..'
  if (name === "." || name === "..") {
    return false
  }

  // Cannot match Windows reserved device names
  if (WINDOWS_RESERVED_NAMES.test(name)) {
    return false
  }

  return true
}

/**
 * Sanitizes an agent identifier into a safe token for branch and directory names.
 * Replaces non-alphanumeric characters with hyphens and collapses repetitions.
 */
export function sanitizeAgentId(raw: string): string {
  const sanitized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return sanitized.length > 0 ? sanitized : "agent"
}

/**
 * Sanitizes a session identifier into a safe token for branch and directory names.
 * Strips invalid characters, collapses hyphens/dots, and removes .lock suffixes.
 */
export function sanitizeSessionId(raw: string): string {
  const sanitized = raw
    .replace(/[\s<>:"/\\|?*~^\[\]@{}]/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\.lock$/gi, "")
    .replace(/^[-.]+|[-.]+$/g, "")

  return sanitized.length > 0 ? sanitized : "session"
}

/**
 * Extracts and sanitizes the project directory basename from projectPath or projectId.
 */
export function sanitizeProjectName(projectPath: string, projectId: string): string {
  const normalized = projectPath.replace(/\\/g, "/").replace(/\/+$/, "")
  const parts = normalized.split("/")
  const rawBase = parts[parts.length - 1] || projectId || "project"

  const sanitized = rawBase
    .replace(/[\s<>:"/\\|?*~^\[\]@{}]/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")

  return sanitized.length > 0 ? sanitized : "project"
}

/**
 * Where session checkouts live, relative to the project root.
 *
 * Shared with .gitignore and with the snapshot pathspec in snapshot.ts: a tree
 * outside this directory is staged into the next session's snapshot, so the
 * three must agree.
 */
export const SESSION_TREE_DIR = ".ade-trees"


/**
 * True when a branch was created by ADE for a session, rather than by a person.
 *
 * The trailing slash matters: a developer branch literally named `ade` or
 * `adem/...` is not ADE's, and must not be mistaken for a free sandbox.
 */
export function isSessionBranch(branch: string): boolean {
  return branch.startsWith("ade/")
}

/**
 * Derives a git branch name for a new session worktree.
 *
 * Chosen Shape: `ade/${sanitizedAgentId}/${sanitizedSessionId}`
 *
 * Rationale:
 * 1. Namespacing under `ade/` separates agent-created branches from developer feature branches.
 * 2. Grouping by agent (`ade/agy/...`) provides clear categorization in git branch listings.
 * 3. Including the unique `sessionId` ensures distinct branch names across concurrent sessions.
 */
export function deriveBranch(agentId: string, sessionId: string): string {
  const agent = sanitizeAgentId(agentId)
  const session = sanitizeSessionId(sessionId)
  const branch = `ade/${agent}/${session}`

  if (isLegalBranch(branch)) {
    return branch
  }

  // Fallback if unusual characters produced an invalid ref
  const safeAgent = agent.replace(/[^a-zA-Z0-9_-]/g, "") || "agent"
  const safeSession = session.replace(/[^a-zA-Z0-9_-]/g, "") || "session"
  return `ade/${safeAgent}/${safeSession}`
}

/**
 * Derives a directory name for a new session worktree sibling to the project.
 *
 * Chosen Shape: `${sanitizedProjectName}-${sanitizedAgentId}-${sanitizedSessionId}`
 *
 * Rationale:
 * 1. Prefixing with the project name makes sibling directories immediately identifiable on disk.
 * 2. Combining agent and session IDs prevents collision between multiple concurrent sessions.
 * 3. Sanitized with hyphens only, ensuring compatibility across Windows and POSIX filesystems.
 */
export function deriveDirectory(
  projectPath: string,
  projectId: string,
  agentId: string,
  sessionId: string,
): string {
  const project = sanitizeProjectName(projectPath, projectId)
  const agent = sanitizeAgentId(agentId)
  const session = sanitizeSessionId(sessionId)

  let dirName = `${project}-${agent}-${session}`

  // Guard against Windows reserved device names
  if (WINDOWS_RESERVED_NAMES.test(dirName)) {
    dirName = `wt-${dirName}`
  }

  // Ensure length fits within standard filesystem limits (255 chars)
  if (dirName.length > 200) {
    dirName = dirName.slice(0, 200).replace(/[-.]+$/, "")
  }

  if (isLegalDirectory(dirName)) {
    return dirName
  }

  // Deterministic safe fallback
  const safeProject = project.replace(/[^a-zA-Z0-9_-]/g, "") || "project"
  const safeAgent = agent.replace(/[^a-zA-Z0-9_-]/g, "") || "agent"
  const safeSession = session.replace(/[^a-zA-Z0-9_-]/g, "") || "session"
  return `${safeProject}-${safeAgent}-${safeSession}`
}

/**
 * Where a new session should run.
 *
 * Pure planning function that determines whether to reuse an existing worktree
 * or create a new dedicated worktree for a starting agent session.
 *
 * Uniqueness Guarantee without Clocks/Randomness:
 * Uniqueness is guaranteed by embedding the caller-provided `sessionId` in the generated
 * branch and directory names. Each session is assigned a unique `sessionId` by the ADE
 * session supervisor. Because the derivation is a deterministic injective mapping over
 * distinct session identifiers, two sessions planned in the exact same millisecond will
 * never produce colliding branch or directory names.
 */
export function planSessionTree(input: {
  projectId: string
  /** Absolute path of the project's primary worktree. */
  projectPath: string
  /** Every tree currently known, across all projects. */
  trees: Worktree[]
  /** The session about to start. */
  sessionId: string
  /** The agent that will run in it, e.g. "agy". */
  agentId: string
  /** Base branch the new tree should fork from. */
  baseBranch: string
}): TreePlan {
  // Rule 1 & 2: Search for reusable trees belonging strictly to the SAME project.
  // Trees from other projects belong to different repositories and cannot be reused.
  // Trees that are 'occupato' or in 'conflitto' are actively in use and must not be disturbed.
  // Rule 3: Never reuse a DIRTY tree, even when free.
  // If an agent starts in a dirty worktree, it will unintentionally inherit uncommitted
  // file modifications from a previous session and may commit or overwrite them.
  const reusableTrees = input.trees.filter((tree) => {
    if (tree.projectId !== input.projectId) {
      return false
    }
    // Rule 0: only ever hand back a tree ADE made. A developer's own worktree
    // can be free and clean and still not be free to take — it is a branch
    // someone is working on, and an agent turned loose in it would commit into
    // their feature. The `ade/` namespace deriveBranch already establishes is
    // what separates "idle sandbox" from "not mine".
    if (!isSessionBranch(tree.branch)) {
      return false
    }
    if (riskOf(tree) !== "libero") {
      return false
    }
    if (tree.dirty > 0) {
      return false
    }
    return true
  })

  if (reusableTrees.length > 0) {
    // Prefer the most recently active clean free tree, tie-breaking alphabetically by name
    const sorted = [...reusableTrees].sort((a, b) => {
      const timeDiff = b.updatedAt - a.updatedAt
      if (timeDiff !== 0) return timeDiff
      // Pinned locale, for the same reason as compareFileNodes in the sidebar:
      // unpinned collation orders differently per machine, so which tree gets
      // reused would depend on the runner's system locale rather than on the
      // trees themselves.
      return a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true })
    })

    const chosen = sorted[0]
    return {
      reuse: chosen,
      reason: `Riutilizzo dell'albero libero e pulito '${chosen.name}' (branch '${chosen.branch}') per l'agente ${input.agentId}.`,
    }
  }

  // When no clean free tree is available, plan a new dedicated worktree.
  // `directory` stays a NAME: where it is placed on disk is provisioning's
  // business, and keeping it a name is what lets the legality rules above apply
  // to it at all.
  const branch = deriveBranch(input.agentId, input.sessionId)
  const directory = deriveDirectory(input.projectPath, input.projectId, input.agentId, input.sessionId)

  return {
    branch,
    directory,
    reason: `Nessun albero libero e pulito nel progetto. Creazione del nuovo albero '${directory}' sul branch '${branch}' a partire da '${input.baseBranch}'.`,
  }
}
