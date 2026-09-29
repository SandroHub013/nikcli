/**
 * What the menu's «NikVerse» does. There is one world, and it lives in the project it was opened in; asking for
 * it from another project used to focus a panel that was not on screen: nothing visible happened.
 */

export interface OpenablePane {
  id: string
  mode: string
  projectRoot?: string
}

export type NikverseOpening =
  /** No world yet: open one in the active project. */
  | { kind: "open" }
  /** The world is there; `switchTo` is the project to take the user to first, when it is not the active one. */
  | { kind: "focus"; id: string; switchTo?: string }

export function nikverseOpening(panes: readonly OpenablePane[], activeRoot: string | undefined, samePath: (a: string, b: string) => boolean): NikverseOpening {
  const existing = panes.find((pane) => pane.mode === "nikverse")
  if (!existing) return { kind: "open" }
  const away = existing.projectRoot && !(activeRoot && samePath(activeRoot, existing.projectRoot))
  return { kind: "focus", id: existing.id, ...(away ? { switchTo: existing.projectRoot } : {}) }
}
