/**
 * Which pages the browser pane shows in Design mode (D1, D83 = A).
 *
 * A design variant is a page an agent wrote in the project, at
 * `<root>/.ade/design/<k>/<n>.html`, served by ADE's media scheme. In Design
 * mode the pane loads it on that scheme, in a frame without
 * `allow-same-origin`: its origin is opaque, so it cannot read ADE, and the
 * media scheme gives no `Access-Control-Allow-Origin` to `null`, so it cannot
 * read the project's other files either (`media.rs`). What remains is to make
 * sure the pane is only ever pointed at a design page: nothing else of the
 * project — `.env`, the registers, source — goes through here.
 *
 * Strict rather than clever: a path with `..` or `.` segments, or with a
 * percent escape, is refused, not resolved. A design page never needs one,
 * and a resolver that mistook `%2e%2e` for a folder name once is all it takes.
 */

import { mediaUrl, MEDIA_SCHEME } from "../video/video"

const DESIGN_DIR = ".ade/design"

/** A Windows path: compared without regard to case. */
const isWindowsPath = (path: string) => /^[A-Za-z]:/.test(path) || path.includes("\\")

/** Forward slashes, and no trailing slash. */
const slashes = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "")

/**
 * The `ade-media` URL of a design page, or undefined when `path` is not one.
 *
 * Accepted: an `.html` or `.htm` file under `<root>/.ade/design/` of one of
 * `projectRoots` (the projects open in the window). Refused: anything else,
 * and any path that needs normalizing to get there.
 */
export function designUrlFor(path: string, projectRoots: readonly string[], windows?: boolean): string | undefined {
  const file = designFile(path, projectRoots)
  return file === undefined ? undefined : mediaUrl(file, windows)
}

/** `path` with forward slashes when it is a design page of an open project, else undefined. */
function designFile(path: string, projectRoots: readonly string[]): string | undefined {
  if (typeof path !== "string" || !path) return undefined
  // Control characters, a NUL, or a percent escape: never in a page an agent wrote, always in a trick.
  if (/[\u0000-\u001f\u007f]/.test(path) || /%[0-9A-Fa-f]{2}/.test(path)) return undefined
  const file = slashes(path)
  const segments = file.split("/")
  if (segments.some((segment, index) => segment === "." || segment === ".." || (segment === "" && index > 0))) {
    return undefined
  }
  if (!/\.html?$/i.test(file)) return undefined

  for (const root of projectRoots) {
    if (!root) continue
    const fold = (text: string) => (isWindowsPath(root) || isWindowsPath(path) ? text.toLowerCase() : text)
    const dir = `${fold(slashes(root))}/${DESIGN_DIR}/`
    const candidate = fold(file)
    if (candidate.startsWith(dir) && candidate.length > dir.length) return file
  }
  return undefined
}

/**
 * The design page an `ade-media` URL shows, or undefined when it shows
 * anything else: another scheme, another file of the project, a page outside
 * `.ade/design`. How the pane knows its frame is still where it put it.
 */
export function designPathOf(url: string, projectRoots: readonly string[], windows?: boolean): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const onScheme =
    (parsed.protocol === `${MEDIA_SCHEME}:` && parsed.hostname === "localhost") ||
    ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.toLowerCase() === `${MEDIA_SCHEME}.localhost`)
  if (!onScheme || parsed.username || parsed.password || parsed.port) return undefined

  let path: string
  try {
    path = decodeURIComponent(parsed.pathname).replace(/^\//, "")
  } catch {
    return undefined
  }
  const file = designFile(path, projectRoots)
  if (file === undefined) return undefined
  // The URL must be exactly the one this path gives: nothing re-encoded on the way.
  const again = new URL(mediaUrl(file, windows ?? parsed.protocol !== `${MEDIA_SCHEME}:`))
  return again.pathname === parsed.pathname ? file : undefined
}
