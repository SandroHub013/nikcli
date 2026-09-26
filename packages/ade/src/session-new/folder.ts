/**
 * One spelling of a folder, for telling whether two panes, a pane and a
 * conversation, or a claim and a pane are in the same place.
 *
 * Windows hands the same directory back with either slash, with or without a
 * trailing one, and in any case. There were three copies of this rule and a
 * raw `===` in the workbench, and the `===` missed two panes of one folder
 * written `\` and `/` (lettura di Mimo, F5). The chat keeps its own, which
 * says why in its comment.
 */
export function folderKey(cwd: string | undefined): string {
  return (cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

export function sameFolder(a: string | undefined, b: string | undefined): boolean {
  return folderKey(a) === folderKey(b)
}
