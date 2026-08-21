import { Workbench } from "./surface/workbench"
import "./index.css"
import "./dev.css"
import "./browser/browser.css"
import "./session-new/session-new.css"
import "./worktrees/worktree-board.css"

/**
 * The ADE surface: sidebar, board and worktrees.
 * 
 * Exported so the desktop shell can mount it beside the nikcli interface.
 * `dev.tsx` renders it standalone.
 */
export function AdeSurface() {
  return <Workbench />
}
