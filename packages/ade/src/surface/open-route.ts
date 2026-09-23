/**
 * Which pane a file opened from the tree or the search results goes to.
 *
 * By extension, and only for the formats the panel can show: a model goes to
 * the 3D panel, a video the video panel plays goes to a video panel, and
 * everything else to the editor. An `.mkv` or an `.avi` is not in the video
 * list (`PLAYABLE_EXTENSIONS`), so it opens as it did before rather than in a
 * panel that refuses it.
 */

import { pathEquals } from "../host/path"
import { isModel } from "../model3d/model"
import { isPlayable } from "../video/video"
import { t } from "../i18n"

export type FileRoute = "model" | "video" | "editor"

export function routeForFile(path: string): FileRoute {
  if (isModel(path)) return "model"
  if (isPlayable(path)) return "video"
  return "editor"
}

/** What a file pane shows for a file: a viewer of its own, or the editor. */
export type ViewKind = "svg" | "image" | "markdown" | "font" | "audio" | "text"

const VIEW_KINDS: Record<string, ViewKind> = {
  svg: "svg",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  ico: "image",
  bmp: "image",
  avif: "image",
  md: "markdown",
  markdown: "markdown",
  woff2: "font",
  woff: "font",
  ttf: "font",
  otf: "font",
  aac: "audio",
  mp3: "audio",
  m4a: "audio",
  wav: "audio",
  oga: "audio",
  opus: "audio",
}

/**
 * The one place that picks a file pane's viewer, by extension.
 *
 * `routeForFile` still decides the pane (3D, video, editor); inside a file
 * pane this decides what is drawn. An image, a font or a sound is never read
 * as text: it is not UTF-8, and the read only failed.
 */
export function viewKind(path: string): ViewKind {
  const name = path.split(/[\/]/).pop() ?? path
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return "text"
  return VIEW_KINDS[name.slice(dot + 1).toLowerCase()] ?? "text"
}

/** Whether a viewer reads the file as text at all: SVG, markdown and text do. */
export function readsText(kind: ViewKind): boolean {
  return kind === "svg" || kind === "markdown" || kind === "text"
}

/**
 * The pane already showing `path` in the panel `route` names, if any.
 *
 * Compared as paths, not strings: the tree and the search can spell the same
 * file with different case or separators on Windows, and a second click must
 * focus the pane it opened rather than open another.
 */
export function paneShowing<P extends { id: string; mode?: string; videoPath?: string; modelPath?: string }>(
  panes: readonly P[],
  route: "video" | "model",
  path: string,
): P | undefined {
  return panes.find((pane) => {
    const shown = route === "video" ? pane.videoPath : pane.modelPath
    return pane.mode === route && !!shown && pathEquals(shown, path)
  })
}

export type LinkPlacement = "unc" | "inside" | "outside"

export function isUncPath(path: string): boolean {
  let raw = path.trim()
  try {
    if (raw.includes("%")) raw = decodeURIComponent(raw)
  } catch {}
  const forward = raw.replace(/\\/g, "/")
  return forward.startsWith("//")
}

export interface PathSegments {
  prefix: string
  segments: string[]
  isWin: boolean
}

export function normalizeSegments(p: string): PathSegments {
  let raw = p.trim()
  try {
    if (raw.includes("%")) raw = decodeURIComponent(raw)
  } catch {}
  const forward = raw.replace(/\\/g, "/")
  const driveMatch = forward.match(/^([A-Za-z]:)(?:\/(.*)|$)/)
  let prefix = ""
  let rest = forward
  const isWin = !!driveMatch || (typeof process !== "undefined" && process.platform === "win32")
  if (driveMatch) {
    prefix = driveMatch[1].toUpperCase() + "/"
    rest = driveMatch[2] ?? ""
  } else if (forward.startsWith("/")) {
    prefix = "/"
    rest = forward.slice(1)
  }

  const rawSegments = rest.split("/").filter((s) => s.length > 0 && s !== ".")
  const segments: string[] = []
  for (const seg of rawSegments) {
    if (seg === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop()
      } else if (!prefix) {
        segments.push("..")
      }
    } else {
      segments.push(seg)
    }
  }
  return { prefix, segments, isWin }
}

/**
 * Checks whether a path is a UNC network path, inside one of the given roots, or outside.
 *
 * - "unc" if path starts with `\\` or `//` (including `\\?\` and `\\.\`), after replacing slashes.
 * - "inside" if the normalised path begins with one of `roots`, segment by segment, case-insensitively on Windows, resolving `.` and `..`.
 * - "outside" in all other cases.
 */
export function linkPlacement(path: string, roots: readonly string[]): LinkPlacement {
  if (isUncPath(path)) return "unc"
  const target = normalizeSegments(path)
  for (const root of roots) {
    if (!root) continue
    const base = normalizeSegments(root)
    if (target.prefix.toLowerCase() !== base.prefix.toLowerCase()) continue
    if (target.segments.length < base.segments.length) continue
    const isWin = target.isWin || base.isWin
    const match = base.segments.every((seg, i) => {
      const tSeg = target.segments[i]
      return isWin ? tSeg.toLowerCase() === seg.toLowerCase() : tSeg === seg
    })
    if (match) return "inside"
  }
  return "outside"
}

export const OUTSIDE_CONFIRM_MS = 5000

export interface OutsideConfirmationTracker {
  checkAndRecord(path: string, now?: number): boolean
  reset(): void
  pendingPath(): string | undefined
}

export function createOutsideConfirmationTracker(timeoutMs = OUTSIDE_CONFIRM_MS): OutsideConfirmationTracker {
  let pending: { path: string; at: number } | undefined
  return {
    checkAndRecord(path: string, now = Date.now()): boolean {
      if (pending && pathEquals(pending.path, path) && now - pending.at <= timeoutMs) {
        pending = undefined
        return true
      }
      pending = { path, at: now }
      return false
    },
    reset(): void {
      pending = undefined
    },
    pendingPath(): string | undefined {
      return pending?.path
    },
  }
}

/** What `openPathLink` needs from the workbench. */
export interface PathLinkDeps {
  readTextFile?: (path: string, maxBytes?: number) => Promise<unknown>
  open: (path: string, line?: number) => unknown
  /** The file is not there: `path` as resolved. */
  say: (path: string) => void
  /** Project roots to determine inside/outside/unc. If omitted, linkPlacement is not checked. */
  roots?: readonly string[]
  /** Emits a user-facing note (e.g. into terminal/transcript). If omitted, falls back to say. */
  sayNote?: (note: string) => void
  /** Confirmation checker for outside links (e.g. 5-second second click). */
  confirmOutside?: (path: string) => boolean
}

export function resolvePath(target: string, base: string | undefined): string {
  const absolute = /^(?:[A-Za-z]:)?[\\/]/.test(target)
  return absolute || !base ? target : `${base.replace(/[\\/]+$/, "")}/${target.replace(/^\.[\\/]/, "")}`
}

/**
 * A `file:line` clicked in a session: resolved against the session's folder,
 * then opened in the pane its kind goes to.
 *
 * If `deps.roots` is provided:
 * - UNC paths are rejected with `pane.link.unc` note («percorso di rete non aperto»).
 * - Outside paths require confirmation via `confirmOutside` (first click shows `pane.link.outsideConfirm`, second click within 5s opens).
 * - Inside paths open directly.
 */
export async function openPathLink(target: string, base: string | undefined, line: number | undefined, deps: PathLinkDeps): Promise<boolean> {
  const path = resolvePath(target, base)
  if (deps.roots) {
    const placement = linkPlacement(path, deps.roots)
    if (placement === "unc") {
      const note = t("pane.link.unc")
      deps.sayNote ? deps.sayNote(note) : deps.say(note)
      return false
    }
    if (placement === "outside") {
      const confirmed = deps.confirmOutside ? deps.confirmOutside(path) : false
      if (!confirmed) {
        const note = t("pane.link.outsideConfirm")
        deps.sayNote ? deps.sayNote(note) : deps.say(note)
        return false
      }
    }
  }
  if (routeForFile(path) === "editor" && readsText(viewKind(path))) {
    const found = deps.readTextFile ? await deps.readTextFile(path, 1).then(() => true, () => false) : false
    if (!found) {
      deps.say(path)
      return false
    }
  }
  await deps.open(path, line)
  return true
}

export interface MarkdownLinkDeps {
  open: (path: string) => unknown
  say: (note: string) => void
}

/**
 * Opens a file link from a markdown preview:
 * - UNC paths are rejected with `pane.link.unc` («percorso di rete non aperto»).
 * - Outside paths are rejected with `pane.link.outside` («fuori dal progetto»).
 * - Inside paths are opened.
 */
export function openMarkdownFileLink(path: string, roots: readonly string[], deps: MarkdownLinkDeps): boolean {
  const placement = linkPlacement(path, roots)
  if (placement === "unc") {
    deps.say(t("pane.link.unc"))
    return false
  }
  if (placement === "outside") {
    deps.say(t("pane.link.outside"))
    return false
  }
  deps.open(path)
  return true
}
