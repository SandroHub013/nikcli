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
