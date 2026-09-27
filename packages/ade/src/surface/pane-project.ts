/**
 * Which project a pane belongs to, as a folder.
 *
 * A pane used to remember only its project's name, and the project was looked
 * up by that name among the recent ones: two folders called `app` were the
 * same project, and a session of the second restarted in the first. A pane
 * now remembers the folder too; the name is only for panes saved before.
 */

import { pathEquals } from "../host/path"

export interface ProjectRef {
  readonly name: string
  readonly root: string
}

export type PaneProject = { readonly kind: "open" } | { readonly kind: "root"; readonly root: string }

export function paneProject(
  pane: { readonly workspaceId?: string; readonly projectRoot?: string } | undefined,
  open: ProjectRef | undefined,
  recents: readonly ProjectRef[],
): PaneProject {
  if (pane?.projectRoot) {
    return open && pathEquals(pane.projectRoot, open.root) ? { kind: "open" } : { kind: "root", root: pane.projectRoot }
  }
  const owner = pane?.workspaceId
  if (!owner || owner === open?.name) return { kind: "open" }
  const entry = recents.find((candidate) => candidate.name === owner)
  return entry ? { kind: "root", root: entry.root } : { kind: "open" }
}

/**
 * The folder a pane's session would start in, when it is gone: its worktree,
 * else its project's root, else the open project's. Undefined when it is
 * there, or when there is nothing to ask about.
 *
 * Without it a session of a project whose folder was removed fell back on the
 * open project (`discoverProject` failing in the gone folder) and started
 * there — somebody else's folder — or died starting in a worktree that was
 * gone. `missing` is `rootMissing` on the host: never true for a remote Space.
 */
export async function goneFolder(
  pane: { readonly workspaceId?: string; readonly projectRoot?: string; readonly worktree?: string } | undefined,
  open: ProjectRef | undefined,
  recents: readonly ProjectRef[],
  missing: (path: string) => Promise<boolean>,
): Promise<string | undefined> {
  if (pane?.worktree) return (await missing(pane.worktree)) ? pane.worktree : undefined
  const found = paneProject(pane, open, recents)
  const root = found.kind === "root" ? found.root : open?.root
  return root && (await missing(root)) ? root : undefined
}

/**
 * Whether a pane is one of `project`'s sessions: by folder when the pane
 * keeps one, by name for a pane saved before. The grid and the pane counts
 * ask this, so two projects called `app` opened in turn do not share a grid.
 */
export function belongsTo(
  pane: { readonly workspaceId?: string; readonly projectRoot?: string },
  project: ProjectRef,
): boolean {
  return pane.projectRoot ? pathEquals(pane.projectRoot, project.root) : pane.workspaceId === project.name
}

/** Whether two panes are of the same project; by name only when either lacks a folder. */
export function sameProject(
  a: { readonly workspaceId?: string; readonly projectRoot?: string },
  b: { readonly workspaceId?: string; readonly projectRoot?: string },
): boolean {
  return a.projectRoot && b.projectRoot ? pathEquals(a.projectRoot, b.projectRoot) : a.workspaceId === b.workspaceId
}
