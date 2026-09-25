/**
 * Files the chat sends with a message (C6): a picked attachment or an
 * `@file` mention, always a file of the project the chat is admitted to.
 *
 * nikcli reads a `file://` part itself, as the user, with no permission asked
 * (`session/prompt.ts`), so the folder is enforced here and again in the
 * store before anything is sent: a path outside it, on another drive, a UNC
 * share or a `\\?\` path is refused, and `..` is resolved before the
 * comparison. The check is on the path as written; a link inside the project
 * that points out of it is not followed here.
 */

import type { FilePartInput } from "@nikcli-ai/sdk/httpapi"

export interface Attachment {
  /** Absolute, with forward slashes. */
  readonly path: string
  /** Relative to the project, with forward slashes: what `@` shows. */
  readonly relative: string
  readonly mime: string
}

/** Forward slashes, `.` and `..` resolved; undefined when `..` climbs above the start. */
function normalize(path: string): string | undefined {
  const slashes = path.replace(/\\/g, "/")
  const drive = /^[A-Za-z]:\//.exec(slashes)?.[0]
  const rooted = drive ?? (slashes.startsWith("/") ? "/" : "")
  const out: string[] = []
  for (const segment of slashes.slice(rooted.length).split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (out.length === 0) return undefined
      out.pop()
    } else out.push(segment)
  }
  return rooted + out.join("/")
}

/** A drive path compares without case, as Windows does. */
function key(path: string): string {
  return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path
}

/**
 * `path` as an absolute path inside `root`, or undefined when it is not one.
 * A relative path is taken from `root`.
 */
export function insideProject(root: string, path: string): string | undefined {
  if (!root || !path) return undefined
  // UNC shares and device paths: never a project file.
  if (/^[\\/]{2}/.test(path) || /^[\\/]{2}/.test(root)) return undefined
  // `C:foo` is relative to the drive's current folder: not a path to trust.
  if (/^[A-Za-z]:(?![\\/])/.test(path)) return undefined
  const base = normalize(root)
  if (!base || !(/^[A-Za-z]:\//.test(base) || base.startsWith("/"))) return undefined
  const absolute = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") ? path : `${base}/${path}`
  const resolved = normalize(absolute)
  if (!resolved) return undefined
  const folder = base.endsWith("/") ? base : `${base}/`
  return key(resolved).startsWith(key(folder)) && resolved.length > folder.length ? resolved : undefined
}

const IMAGE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
}

/** Images and PDFs go to the model as media; anything else as text nikcli reads. */
export function mimeOf(path: string): string {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? ""
  if (extension === "pdf") return "application/pdf"
  return IMAGE[extension] ?? "text/plain"
}

/**
 * `.env` or `.env.*`: never attached (C6 review). nikcli guards those files for
 * its read tool, and an attachment is read without that guard.
 */
export function isEnvFile(path: string): boolean {
  const name = (path.replace(/\\/g, "/").split("/").at(-1) ?? "").toLowerCase()
  return name === ".env" || name.startsWith(".env.")
}

/*
 * Files `@` does not offer (C6 review): programs, libraries, archives,
 * compiled output, fonts, audio and video, databases. Sent as text they are
 * noise to the model; images and PDFs are not here, they go as media.
 */
const BINARY = new Set(
  (
    "exe dll so dylib bin o obj a lib pdb class jar war pyc pyo node wasm " +
    "zip gz tgz bz2 xz 7z rar tar zst iso dmg msi cab deb rpm apk " +
    "woff woff2 ttf otf eot ico " +
    "mp3 wav flac ogg m4a aac mp4 mkv mov avi webm " +
    "db sqlite sqlite3 mdb bak dat"
  ).split(" "),
)

/** A file `@` should not offer: by its extension (`BINARY`). */
export function isBinaryPath(path: string): boolean {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase()
  return extension !== undefined && BINARY.has(extension)
}

/** What `@` offers of the server's matches: not a `.env`, not a binary. */
export function mentionCandidates(paths: readonly string[]): string[] {
  return paths.filter((path) => !isEnvFile(path) && !isBinaryPath(path))
}

/** An attachment for `path` in `root`, or undefined when the path is outside it. */
export function attachmentFor(root: string, path: string): Attachment | undefined {
  const absolute = insideProject(root, path)
  if (!absolute) return undefined
  const base = normalize(root)!
  const relative = absolute.slice(base.replace(/\/$/, "").length + 1)
  return { path: absolute, relative, mime: mimeOf(absolute) }
}

/** `file://` URL for an absolute path, each segment encoded; a drive path gets its leading slash. */
export function fileUrl(path: string): string {
  const slashes = path.replace(/\\/g, "/")
  const rooted = /^[A-Za-z]:\//.test(slashes) ? `/${slashes}` : slashes
  return `file://${rooted
    .split("/")
    .map((segment, index) => (index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/")}`
}

/** The path a `file://` URL names, for checking it again before it is sent. */
export function pathOfFileUrl(url: string): string | undefined {
  // `file:///…` only: `file://host/…` names a share on another machine, which nikcli would read as `\\host\…`.
  if (!url.startsWith("file:///")) return undefined
  try {
    const path = decodeURIComponent(url.slice("file://".length).split("?")[0]!)
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path
  } catch {
    return undefined
  }
}

export function attachmentParts(attachments: readonly Attachment[]): FilePartInput[] {
  return attachments.map((attachment) => ({
    type: "file",
    mime: attachment.mime,
    url: fileUrl(attachment.path),
    filename: attachment.relative.split("/").at(-1) ?? attachment.relative,
  }))
}

/** One of each path, in the order first added. */
export function addAttachment(list: readonly Attachment[], next: Attachment): Attachment[] {
  return list.some((item) => key(item.path) === key(next.path)) ? [...list] : [...list, next]
}

/**
 * The `@` word the caret is in, for completion: from an `@` at the start or
 * after a space up to the caret, with no space in it.
 */
export function mentionAt(text: string, caret: number): { start: number; query: string } | undefined {
  const before = text.slice(0, caret)
  const match = /(^|\s)@([^\s@]*)$/.exec(before)
  if (!match) return undefined
  return { start: caret - match[2]!.length - 1, query: match[2]! }
}

/** The text with the `@` word at `start..caret` replaced by `@relative `, and where the caret goes. */
export function completeMention(
  text: string,
  mention: { start: number },
  caret: number,
  relative: string,
): { text: string; caret: number } {
  const rest = text.slice(caret)
  // One space after the path: the one already there, or a new one.
  const inserted = /^\s/.test(rest) ? `@${relative}` : `@${relative} `
  return { text: text.slice(0, mention.start) + inserted + rest, caret: mention.start + `@${relative} `.length }
}
