import path from "path"
import { existsSync, statSync } from "fs"

type PathEnv = {
  platform?: NodeJS.Platform
  exists?: (target: string) => boolean
}

/**
 * The one place a file tool turns the path the model wrote into a path on disk.
 *
 * A model copies whatever its shell printed, and on Windows that is several dialects of one place:
 * `/c/work/x` (Git Bash), `/C:/work/x` (a file URL), `C:\work\x`, and `/src/x`, which it means as
 * "src in the project" and the OS reads as "src at the root of the drive". The first two become
 * `C:\work\x`; the last is the project's own `src/x` when the project has a `src` and the drive root has
 * no such path. A relative path is relative to the project, as before, and a path that really exists
 * is left alone.
 */
export function normalizeToolPath(value: string, root: string, env: PathEnv = {}): string {
  const win = (env.platform ?? process.platform) === "win32"
  const exists = env.exists ?? existsSync
  const p = win ? path.win32 : path.posix
  let raw = value.trim().replace(/^(["'])(.*)\1$/, "$2")
  if (!raw) return root

  if (win) {
    // `/c/work/x` and `/c` (MSYS): the single letter is a drive.
    const msys = raw.match(/^[\\/]([a-zA-Z])(?:[\\/](.*))?$/)
    if (msys) raw = `${msys[1]!.toUpperCase()}:\\${msys[2] ?? ""}`
    // `/C:/work/x` (file URL form), also with several leading slashes.
    const url = raw.match(/^[\\/]+([a-zA-Z]:)([\\/].*)?$/)
    if (url) raw = `${url[1]!.toUpperCase()}${url[2] ?? "\\"}`
  }

  if (!p.isAbsolute(raw)) return p.resolve(root, raw)
  // resolve, not normalize: a drive-less `\src\x` takes the project's drive.
  const absolute = p.resolve(root, raw)
  if (exists(absolute)) return absolute

  // A rooted path that is not there (`/src/x`, `C:\src\x`): if its first segment is a directory of
  // the project, it was meant as relative to the project.
  const rest = absolute.slice(p.parse(absolute).root.length)
  const first = rest.split(/[\\/]/)[0]
  if (first && exists(p.join(root, first))) return p.join(root, rest)
  return absolute
}

/**
 * The directory a `bash` call runs in. The model writes `workdir` the way its shell printed it, so it goes
 * through the same normaliser as the file tools (`/c/work/x` is `C:\work\x`; a relative one is relative to the
 * project). A directory that is not there fails here, with its own name in the message: left to `spawn`, the
 * error that comes back names the shell binary and sends the model looking at the wrong thing.
 */
export function resolveWorkdir(value: string, root: string, env: PathEnv & { isDirectory?: (target: string) => boolean } = {}): string {
  const resolved = normalizeToolPath(value, root, env)
  const isDirectory =
    env.isDirectory ??
    ((target: string) => {
      try {
        return statSync(target).isDirectory()
      } catch {
        return false
      }
    })
  if (!isDirectory(resolved)) throw new Error(`workdir does not exist: ${resolved} (from "${value}")`)
  return resolved
}
