/**
 * What opening a plugin's panel does. There is one panel per plugin, and it lives in the project it was opened in; asking for it from
 * another project takes the user there first, as `nikverse/open.ts` does for its own.
 */

export interface OpenablePane {
  id: string
  framePlugin?: { id: string }
  projectRoot?: string
}

export type FramePluginOpening =
  /** No panel of this plugin yet: open one in the active project. */
  | { kind: "open" }
  /** It is there; `switchTo` is the project to take the user to first, when it is not the active one. */
  | { kind: "focus"; id: string; switchTo?: string }

export function framePluginOpening(
  panes: readonly OpenablePane[],
  pluginId: string,
  activeRoot: string | undefined,
  samePath: (a: string, b: string) => boolean,
): FramePluginOpening {
  const existing = panes.find((pane) => pane.framePlugin?.id === pluginId)
  if (!existing) return { kind: "open" }
  const away = existing.projectRoot && !(activeRoot && samePath(activeRoot, existing.projectRoot))
  return { kind: "focus", id: existing.id, ...(away ? { switchTo: existing.projectRoot } : {}) }
}
