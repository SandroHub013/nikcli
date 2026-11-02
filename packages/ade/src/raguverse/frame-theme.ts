/**
 * The scheme the frames are told to wear (DS-25).
 *
 * The world and the lesson page are frames with no access to ADE's stylesheet or to its `data-theme`, and until now they followed the
 * OS (`prefers-color-scheme`), so ADE in light on a dark OS showed a dark Raguverse. ADE says which one in the frame's address
 * (`?theme=` for the world, `&t=` in the lesson page's fragment), and the page sets `data-theme` on its own `<html>` from it.
 *
 * Glass is dark: its ground is ink. A frame opened is told the scheme of that moment; a change of theme reaches it at its next load.
 */
export type FrameTheme = "light" | "dark"

export function frameTheme(root: ParentNode = document): FrameTheme {
  const shell = root.querySelector('[data-component="ade-shell"]')
  return shell?.getAttribute("data-theme") === "light" ? "light" : "dark"
}
