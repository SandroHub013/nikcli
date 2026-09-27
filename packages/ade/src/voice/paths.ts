/*
 * The paths a voice command names (M11, verdict of area 3). «apri file …» and
 * «apri il progetto recente …» took a token the recogniser heard and opened
 * it: any file on the disk, any folder as a project, with no question. Now a
 * file inside the open project and a project among the recent ones open as
 * before; anything else is asked first.
 */
import { linkPlacement } from "../surface/open-route"

/** Absolute: a drive, a leading slash or a UNC share. A relative path is the project's. */
function isAbsolute(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.startsWith("/") || path.startsWith("\\")
}

/**
 * A dictated file path as ADE opens it: a relative one is read from the
 * project's root, so it is resolved there, not against wherever the process
 * happens to run. `inside` is whether it stays in the project, `..` included.
 */
export function dictatedFile(
  path: string,
  root: string | undefined,
): { readonly path: string; readonly inside: boolean } {
  const trimmed = path.trim()
  const resolved = isAbsolute(trimmed) || !root ? trimmed : `${root.replace(/[\\/]+$/, "")}/${trimmed}`
  return { path: resolved, inside: Boolean(root) && linkPlacement(resolved, [root!]) === "inside" }
}

/** Whether `root` is one of the recent projects, the same folder however it is spelled. */
export function isRecentRoot(root: string, recents: readonly { readonly root: string }[]): boolean {
  const wanted = root.trim()
  if (!wanted) return false
  return recents.some(
    (entry) => linkPlacement(wanted, [entry.root]) === "inside" && linkPlacement(entry.root, [wanted]) === "inside",
  )
}
