import { onCleanup, onMount } from "solid-js"
import { Workbench } from "./surface/workbench"
import { watchRealWindowIdle } from "./surface/window-idle"
import "./index.css"
import "./dev.css"
import "./browser/browser.css"
import "./session-new/session-new.css"
import "../../voice/src/ui/voice.css"

/**
 * The ADE surface: the sidebar and the grid of panes.
 *
 * Exported so the desktop shell can mount it beside the ragu interface.
 * `dev.tsx` renders it standalone.
 */
export function AdeSurface() {
  // Animations pause while the window is covered or without the focus (full review 2026-10-06, sessions 11).
  onMount(() => onCleanup(watchRealWindowIdle()))
  return <Workbench />
}
