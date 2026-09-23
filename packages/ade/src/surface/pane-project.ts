/**
 * Which project a pane belongs to, as a folder.
 *
 * A pane used to remember only its project's name, and the project was looked
 * up by that name among the recent ones: two folders called `app` were the
 * same project, and a session of the second restarted in the first. A pane
 * now remembers the folder too; the name is only for panes saved before.
 */

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
    return open && samePath(pane.projectRoot, open.root) ? { kind: "open" } : { kind: "root", root: pane.projectRoot }
  }
  const owner = pane?.workspaceId
  if (!owner || owner === open?.name) return { kind: "open" }
  const entry = recents.find((candidate) => candidate.name === owner)
  return entry ? { kind: "root", root: entry.root } : { kind: "open" }
}

/** Windows paths: the same folder may come back with the other slash or another case. */
function samePath(a: string, b: string): boolean {
  const norm = (path: string) => path.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase()
  return norm(a) === norm(b)
}
