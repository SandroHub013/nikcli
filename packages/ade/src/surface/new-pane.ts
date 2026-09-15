/**
 * What the multiframe button opens.
 *
 * The bar used to carry one button per kind of pane — "+ browser", then
 * "+ sessione" — which is a shape that only works while there are two. With
 * a video player, and a mobile emulator and a 3D viewer behind it, the bar
 * would be a row of verbs competing with the navigation it sits next to.
 *
 * One button, one menu, and the list here. Kept apart from the component so
 * the set can be asserted — every entry runs a command, and a menu entry
 * that names a command nothing handles is a button that does nothing.
 */

import type { AdeView } from "./state"

export interface NewPaneItem {
  /** The command `runCommand` will be given. */
  readonly commandId: string
  readonly label: string
  /** One line under the label: what this pane is actually for. */
  readonly hint: string
  /** Drawn by the component; named here so the order and the icon agree. */
  readonly glyph: "session" | "browser" | "video" | "model" | "app"
  /** The one the button performs on a plain click, without opening the menu. */
  readonly primary?: true
}

/**
 * In the order they are offered.
 *
 * A session first because it is what ADE is for, and because it is the one
 * the old bar gave its primary button to: a menu that reorders the thing
 * people already reach for costs them the muscle memory for no gain.
 */
export const NEW_PANE_ITEMS: readonly NewPaneItem[] = [
  {
    commandId: "session.new",
    label: "Sessione",
    hint: "un agente in un terminale",
    glyph: "session",
    primary: true,
  },
  {
    commandId: "browser.new",
    label: "Browser",
    hint: "la pagina che stai costruendo",
    glyph: "browser",
  },
  {
    commandId: "video.new",
    label: "Video",
    hint: "guarda un file del progetto, e falla guardare all'agente",
    glyph: "video",
  },
  {
    commandId: "model.new",
    label: "Modello 3D",
    hint: "glTF, OBJ, STL o FBX, ricaricato quando il file cambia",
    glyph: "model",
  },
  {
    commandId: "app.new",
    label: "Simulatore app",
    hint: "l'app del dev server in un telefono o in una finestra",
    glyph: "app",
  },
]

/** The entry a plain click performs. */
export function primaryItem(items: readonly NewPaneItem[] = NEW_PANE_ITEMS): NewPaneItem | undefined {
  return items.find((item) => item.primary) ?? items[0]
}

/**
 * Whether the button belongs on the bar at all.
 *
 * Panes live in the grid, and the grid is the `code` section. Offering "new
 * pane" while the user is reading a chat would create something they cannot
 * see, which is the defect the browser pane already had once.
 */
export function showsNewPane(view: AdeView): boolean {
  return view === "code"
}
