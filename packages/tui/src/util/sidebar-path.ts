/**
 * The sidebar's foot shows the folder as «parent/name:branch», the name drawn brighter. Split on either separator (a
 * Windows folder has no "/"), and keep the branch out of the split: «feat/ade» has a "/" of its own.
 */
export function sidebarPath(directory: string, branch?: string): { parent: string; name: string } {
  const trimmed = directory.replace(/[\\/]+$/, "")
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  const parent = cut >= 0 ? trimmed.slice(0, cut + 1) : ""
  const name = (cut >= 0 ? trimmed.slice(cut + 1) : trimmed) + (branch ? `:${branch}` : "")
  return { parent, name }
}
