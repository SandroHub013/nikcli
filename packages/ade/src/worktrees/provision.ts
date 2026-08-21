/**
 * Turning a plan into a real directory on disk.
 *
 * `session-tree.ts` decides where a session should run; this runs the git that
 * makes it so. Kept apart because the deciding is worth testing and the running
 * is not: the interesting failures here are git's, and git reports them itself.
 */
import type { Host } from "../host/shell"
import { planDependencyLinks } from "./dependencies"
import { countDirty, parseAheadBehind, parseWorktreeList, toWorktree } from "./git"
import type { Occupant, Worktree } from "./model"
import { SESSION_TREE_DIR, planSessionTree } from "./session-tree"
import { planSnapshot } from "./snapshot"

/** Reads the project's real worktrees, with their branch and dirty state. */
export async function loadWorktrees(input: {
  host: Host
  projectId: string
  projectPath: string
  /** Who is inside which tree, by tree path. ADE knows this, git does not. */
  occupantsByPath?: Map<string, Occupant[]>
  now: number
}): Promise<Worktree[]> {
  const listed = await input.host.run("git", ["worktree", "list", "--porcelain"], input.projectPath)
  if (listed.code !== 0) return []

  const parsed = parseWorktreeList(listed.stdout)

  return Promise.all(
    parsed.map(async (tree) => {
      const [status, counts] = await Promise.all([
        input.host.run("git", ["status", "--porcelain"], tree.path),
        input.host.run("git", ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], tree.path),
      ])
      const { ahead, behind } = parseAheadBehind(counts.code === 0 ? counts.stdout : "")
      return toWorktree({
        parsed: tree,
        projectId: input.projectId,
        projectPath: input.projectPath,
        dirty: status.code === 0 ? countDirty(status.stdout) : 0,
        ahead,
        behind,
        occupants: input.occupantsByPath?.get(tree.path) ?? [],
        updatedAt: input.now,
      })
    }),
  )
}

export interface Provisioned {
  /** Where the agent should run. */
  cwd: string
  /** What to tell the user in the pane's first line. */
  note: string
  /** True when a checkout was created for this session. */
  created: boolean
  /**
   * How faithful the tree is to what the session asked for. The note says it in
   * words, but a note scrolls away after three messages and the pane's footer
   * does not — so the same fact travels as a value the chrome can keep showing.
   * Mirrors PaneTreeFidelity in grid/pane.tsx; kept as a string union here so
   * the worktree layer does not import the view.
   */
  fidelity: "full" | "stale" | "no-deps" | "project"
  /** Branch the session runs on, for the pane's footer. */
  branch: string
  /**
   * The commit the checkout started from. Reviewing what a session changed is
   * a diff against this and nothing else: the branch name would also drag in
   * whatever the user committed elsewhere in the meantime.
   */
  baseCommit: string
}

/**
 * Gives a session somewhere isolated to run.
 *
 * Falls back to the project directory when git refuses: a session that runs in
 * the project is worse than one in its own tree, but far better than a session
 * that does not run at all and leaves the user guessing why.
 */
export async function provisionSessionTree(input: {
  host: Host
  projectId: string
  projectPath: string
  trees: Worktree[]
  sessionId: string
  agentId: string
  baseBranch: string
  packageDirs?: string[]
}): Promise<Provisioned> {
  const plan = planSessionTree({
    projectId: input.projectId,
    projectPath: input.projectPath,
    trees: input.trees,
    sessionId: input.sessionId,
    agentId: input.agentId,
    baseBranch: input.baseBranch,
  })

  // A reused tree is clean by the reuse rule, which means it sits at its branch
  // tip: isolated, but without the uncommitted work a fresh snapshot would carry.
  // That is exactly `stale`, and erring toward the more cautious label is right.
  if (plan.reuse) {
    return {
      cwd: plan.reuse.path,
      note: plan.reason,
      created: false,
      fidelity: "stale",
      branch: plan.reuse.branch,
      // A reused tree sits at its branch tip, so that tip is what it was cut from.
      baseCommit: plan.reuse.branch,
    }
  }

  // No tree at all: the agent edits the project the user is looking at.
  const projectBranch = input.trees.find((tree) => tree.path === input.projectPath)?.branch ?? input.baseBranch

  if (!plan.directory || !plan.branch) {
    return {
      cwd: input.projectPath,
      note: "Nessun piano di isolamento: eseguo nel progetto.",
      created: false,
      fidelity: "project",
      branch: projectBranch,
      baseCommit: input.baseBranch,
    }
  }

  // Snapshot the working tree into a dangling commit using a throwaway index.
  // Note on index copy: git add -A uses stat cache from an existing index for speed.
  // Because the host allowlist strictly permits git and agent binaries (no cp, no shell/cmd),
  // we start from an absent throwaway index. Git creates it on demand. On large repos this
  // requires a full scan of files, costing a couple seconds, but preserves total host isolation.
  const snapshot = planSnapshot({
    projectPath: input.projectPath,
    baseCommit: input.baseBranch,
  })

  let baseCommitOrBranch = input.baseBranch
  let snapshotFailure: string | null = null

  // Step 1: Stage current working tree into throwaway index
  const stageResult = await input.host.run("git", snapshot.stageArgs, input.projectPath, snapshot.env)
  if (stageResult.code !== 0) {
    snapshotFailure = (stageResult.stderr || stageResult.stdout).trim().split("\n")[0] || "stage fallito"
  } else {
    // Step 2: Write tree from throwaway index
    const writeTreeResult = await input.host.run("git", snapshot.writeTreeArgs, input.projectPath, snapshot.env)
    const treeId = writeTreeResult.stdout.trim()
    if (writeTreeResult.code !== 0 || !treeId) {
      snapshotFailure = (writeTreeResult.stderr || writeTreeResult.stdout).trim().split("\n")[0] || "write-tree fallito"
    } else {
      // Step 3: Commit the tree referencing baseCommit as parent
      const commitResult = await input.host.run("git", snapshot.commitArgs(treeId), input.projectPath, snapshot.env)
      const commitId = commitResult.stdout.trim()
      if (commitResult.code !== 0 || !commitId) {
        snapshotFailure = (commitResult.stderr || commitResult.stdout).trim().split("\n")[0] || "commit-tree fallito"
      } else {
        baseCommitOrBranch = commitId
      }
    }
  }

  // Where the checkout goes, spelled absolutely. Two reasons it cannot be a
  // bare name: `git worktree add` resolves a relative path against the process
  // it runs in, and the same string is handed to spawn as the agent's cwd.
  // `.ade-trees/` is the one place .gitignore hides and the snapshot pathspec
  // excludes — a tree anywhere else becomes part of the user's uncommitted
  // work and is swallowed by the next session's snapshot.
  const cleanProject = input.projectPath.replace(/\\/g, "/").replace(/\/+$/, "")
  const worktreePath = `${cleanProject}/${SESSION_TREE_DIR}/${plan.directory}`

  const added = await input.host.run(
    "git",
    ["worktree", "add", "-b", plan.branch, worktreePath, baseCommitOrBranch],
    input.projectPath,
  )

  if (added.code !== 0) {
    const reason = (added.stderr || added.stdout).trim().split("\n")[0] ?? "motivo sconosciuto"
    return {
      cwd: input.projectPath,
      note: `Albero isolato non creato (${reason}). Eseguo nel progetto.`,
      created: false,
      fidelity: "project",
      branch: projectBranch,
      baseCommit: input.baseBranch,
    }
  }

  // Worktree created. Plan dependency links so the isolated tree can run tooling.
  const packageDirs = input.packageDirs ?? ["packages/ade"]
  const links = planDependencyLinks({
    projectPath: input.projectPath,
    worktreePath,
    packageDirs,
  })

  // One purpose-built command instead of a shell call: see host.linkDirectory.
  // A failure here degrades the session rather than ending it — the agent can
  // still read and edit, it just cannot run the project's tooling.
  const failures: string[] = []
  for (const link of links) {
    const error = await input.host.linkDirectory(`${worktreePath}/${link.target}`, link.source)
    if (error) failures.push(`${link.target} (${error})`)
  }

  // What the tree CONTAINS is the fact the user needs, and it is not implied by
  // "isolated": a snapshot tree carries their uncommitted work, a fallback tree
  // silently reverts it. Naming the base branch here would be worse than vague —
  // it is usually the string "HEAD", which tells a reader nothing.
  const baseNote = snapshotFailure
    ? `${plan.reason} Snapshot non riuscito (${snapshotFailure}): l'albero contiene l'ultimo commit, non le modifiche non salvate.`
    : `${plan.reason} Contiene il lavoro corrente, comprese le modifiche non salvate.`

  // Only one fidelity can be shown, so it names the worse problem: an agent in a
  // stale tree is editing code that is not what the user sees, while one without
  // dependencies is editing the right code and merely cannot run the tooling.
  const fidelity = snapshotFailure ? "stale" : failures.length > 0 ? "no-deps" : "full"

  if (failures.length > 0) {
    return {
      cwd: worktreePath,
      note: `${baseNote} Dipendenze non collegate (${failures.join(", ")}).`,
      created: true,
      fidelity,
      branch: plan.branch,
      baseCommit: baseCommitOrBranch,
    }
  }

  return {
    cwd: worktreePath,
    note: baseNote,
    created: true,
    fidelity,
    branch: plan.branch,
    baseCommit: baseCommitOrBranch,
  }
}
