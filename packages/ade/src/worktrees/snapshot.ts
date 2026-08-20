/**
 * Pure planning of git snapshot invocations.
 *
 * To isolate an autonomous agent session while preserving uncommitted work in
 * the working tree, ADE creates a dangling commit capturing the exact dirty
 * state using a throwaway index. This commit serves as the base for the new
 * session worktree without touching the user's active branch or index.
 *
 * This module is completely pure: no filesystem access, no child processes,
 * and no clocks.
 */

/** The git invocations that turn a dirty working tree into one commit. */
export interface SnapshotPlan {
  /** Absolute path of the throwaway index. Never the repository's own. */
  indexPath: string
  /** Environment every step below must run with. */
  env: Record<string, string>
  /** `git add -A` arguments. */
  stageArgs: string[]
  /** `git write-tree` arguments. */
  writeTreeArgs: string[]
  /** `git commit-tree` arguments, given the tree id `write-tree` printed. */
  commitArgs: (treeId: string) => string[]
}

/**
 * Pure: takes the project path, returns what to run. No filesystem, no
 * processes, no clock.
 */
export function planSnapshot(input: { projectPath: string; baseCommit: string }): SnapshotPlan {
  // Normalize Windows backslashes and strip trailing slashes so path operations
  // are deterministic and produce clean POSIX-style paths across all platforms.
  const cleanProject = input.projectPath.replace(/\\/g, "/").replace(/\/+$/, "")

  // The throwaway index sits inside the repository's own .git directory so it
  // resides on the same filesystem and metadata hierarchy, but uses a dedicated
  // distinct name ('ade-snapshot-index') to guarantee it can never collide with
  // or overwrite the repository's real index file ('index') or index.lock.
  const indexPath = `${cleanProject}/.git/ade-snapshot-index`

  return {
    indexPath,
    // GIT_INDEX_FILE redirects git's staging operations to the throwaway index,
    // leaving the user's working index completely untouched.
    env: {
      GIT_INDEX_FILE: indexPath,
    },
    // Stage all dirty changes (modified, added, deleted).
    // Explicitly exclude .ade-trees via negative pathspec: ADE's session worktrees
    // live inside .ade-trees/. Even though .ade-trees is in .gitignore, a checkout
    // inside a checkout is the one thing that must never be staged into a snapshot,
    // so we make the exclusion explicit rather than relying on .gitignore staying intact.
    stageArgs: ["add", "-A", "--", ":!.ade-trees"],
    // Writes the staged throwaway index into a git tree object.
    writeTreeArgs: ["write-tree"],
    // Commits the tree object with baseCommit as the parent, producing a dangling
    // snapshot commit without moving any ref or HEAD.
    commitArgs: (treeId: string) => [
      "commit-tree",
      treeId.trim(),
      "-p",
      input.baseCommit,
      "-m",
      "ade session snapshot",
    ],
  }
}
