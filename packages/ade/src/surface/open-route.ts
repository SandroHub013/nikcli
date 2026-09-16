/**
 * Which pane a file opened from the tree or the search results goes to.
 *
 * By extension, and only for the formats the panel can show: a model goes to
 * the 3D panel, a video the video panel plays goes to a video panel, and
 * everything else to the editor. An `.mkv` or an `.avi` is not in the video
 * list (`PLAYABLE_EXTENSIONS`), so it opens as it did before rather than in a
 * panel that refuses it.
 */

import { isModel } from "../model3d/model"
import { isPlayable } from "../video/video"

export type FileRoute = "model" | "video" | "editor"

export function routeForFile(path: string): FileRoute {
  if (isModel(path)) return "model"
  if (isPlayable(path)) return "video"
  return "editor"
}
