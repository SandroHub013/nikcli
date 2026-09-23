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

/** What `openPathLink` needs from the workbench. */
export interface PathLinkDeps {
  readTextFile?: (path: string, maxBytes?: number) => Promise<unknown>
  open: (path: string, line?: number) => unknown
  /** The file is not there: `path` as resolved. */
  say: (path: string) => void
}

/**
 * A `file:line` clicked in a session: resolved against the session's folder,
 * then opened in the pane its kind goes to.
 *
 * Existence is checked by reading one byte as text, which only works for a
 * file that is text. A picture, a font, a sound, a video or a model fails that
 * read as binary, and every link to one used to say «File non trovato»; those
 * go straight to their pane, which says for itself if it cannot draw them.
 */
export async function openPathLink(target: string, base: string | undefined, line: number | undefined, deps: PathLinkDeps): Promise<void> {
  const absolute = /^(?:[A-Za-z]:)?[\\/]/.test(target)
  const path = absolute || !base ? target : `${base.replace(/[\\/]+$/, "")}/${target.replace(/^\.[\\/]/, "")}`
  if (routeForFile(path) === "editor" && readsText(viewKind(path))) {
    const found = deps.readTextFile ? await deps.readTextFile(path, 1).then(() => true, () => false) : false
    if (!found) return deps.say(path)
  }
  await deps.open(path, line)
}
