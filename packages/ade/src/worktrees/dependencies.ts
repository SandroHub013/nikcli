/**
 * Pure dependency link planning for isolated session worktrees.
 *
 * MECHANISM SELECTION & DEFENSE:
 * When ADE provisions a new git worktree for an autonomous agent session, git only
 * checks out tracked files. Hoisted and package-level `node_modules` directories are
 * gitignored and therefore absent in the newly created worktree. Without dependencies,
 * the agent cannot execute typechecks (`tsc`), unit tests (`bun test`), or build tools,
 * making self-verification impossible.
 *
 * Alternatives evaluated:
 * 1. `bun install` per worktree:
 *    Rejected because running a full package installation for every agent session
 *    takes minutes, consumes gigabytes of redundant disk space, and drastically degrades
 *    session startup latency.
 * 2. Full directory copy of `node_modules`:
 *    Rejected because copying gigabytes of deeply nested files incurs severe disk I/O
 *    and storage overhead.
 * 3. File-level hardlinks:
 *    Rejected because hardlinks cannot link directories, and linking individual files
 *    across thousands of packages is fragile, slow, and fails across filesystem boundaries.
 * 4. NTFS Junctions (`mklink /J`) on Windows & Symbolic Links (`ln -s`) on POSIX (CHOSEN):
 *    - On Windows, standard directory symbolic links (`mklink /D`) require elevated Administrator
 *      privileges or Developer Mode (`SeCreateSymbolicLinkPrivilege`). In contrast, NTFS Junctions
 *      (`mklink /J`) can be created by standard unprivileged user accounts without elevation.
 *    - On POSIX platforms (Linux / macOS), standard directory symlinks (`ln -s`) are unprivileged
 *      and instantaneous.
 *    - Creating junctions/symlinks is instantaneous (<1ms) and incurs 0 additional disk space.
 *    - Hoisting support: In modern monorepos (Bun/pnpm/Turborepo workspaces), tooling requires both
 *      the repository root `node_modules` (for hoisted devDependencies and binaries) and individual
 *      package `node_modules` (for workspace symlinks and unhoisted dependencies). Linking both
 *      guarantees compiler resolution.
 *    - Safety & Non-corruption: The agent runs read-heavy verification commands (`tsc`, `bun test`,
 *      `vite build`). Directory links allow read access without modifying the source tree. If an agent
 *      or process attempts to write or re-install dependencies, junction targets resolve to the source
 *      checkout; however, agent instructions restrict package mutation.
 *    - Graceful degradation: If linking fails at runtime (e.g. host shell restriction or absent
 *      source node_modules), ADE does not crash the session; it appends the exact reason in Italian
 *      to the session note so the user and agent are informed of missing verification capabilities.
 */

/** A directory that must exist in the new tree for tooling to work. */
export interface DependencyLink {
  /** Path inside the worktree, relative to its root. */
  target: string
  /** Path in the source checkout the target should resolve to. */
  source: string
}

/**
 * Which links a fresh worktree needs, given the package directories the
 * repository contains. Pure: takes paths, returns paths.
 *
 * Hard constraint: touches no filesystem, no child processes, and no clock.
 */
export function planDependencyLinks(input: {
  projectPath: string
  worktreePath: string
  /** Package directories relative to the repo root, e.g. ["packages/ade"]. */
  packageDirs: string[]
}): DependencyLink[] {
  // Normalize the source project path by replacing Windows backslashes and trimming trailing slashes
  const cleanProject = input.projectPath.replace(/\\/g, "/").replace(/\/+$/, "")

  const links: DependencyLink[] = []
  const seenTargets = new Set<string>()

  // 1. The root node_modules link is always planned first
  const rootTarget = "node_modules"
  links.push({
    target: rootTarget,
    source: `${cleanProject}/${rootTarget}`,
  })
  seenTargets.add(rootTarget)

  // 2. Each package directory gets its own node_modules link
  for (const rawPkg of input.packageDirs) {
    if (!rawPkg || typeof rawPkg !== "string") continue

    // Normalize package path: replace backslashes, trim leading/trailing slashes, and remove leading './'
    const cleanPkg = rawPkg
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .replace(/^\.\//, "")

    // Skip empty paths or '.' which designate the root already planned above
    if (cleanPkg.length === 0 || cleanPkg === ".") {
      continue
    }

    const target = `${cleanPkg}/node_modules`
    if (!seenTargets.has(target)) {
      seenTargets.add(target)
      links.push({
        target,
        source: `${cleanProject}/${cleanPkg}/node_modules`,
      })
    }
  }

  return links
}
