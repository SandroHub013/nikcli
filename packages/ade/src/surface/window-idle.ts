/**
 * Whether ADE is out of sight, as one attribute on the root: `data-window-idle` is there while the page is hidden
 * (the window minimised or hidden), and the sheet pauses the loops under it (`--ade-loops`, `index.css`).
 *
 * Only the loops, and only out of sight. A window that merely has no focus is still looked at (ADE on a second monitor
 * while the user works elsewhere): the sweep of the working panes and the blink of a permission waiting must go on
 * there. What costs is a covered or minimised window repainting for nobody (full review 2026-10-06, sessions 11).
 * `document.hidden` is reliable for that case: the Rust side tells WebView2 when the window is minimised or hidden
 * (`follow_window_visibility`), so the page gets `visibilitychange`. Nothing runs while it is idle: a paused CSS
 * animation costs no frames, and this only listens.
 */

export const WINDOW_IDLE_ATTRIBUTE = "data-window-idle"

export interface WindowIdleDeps {
  root: { toggleAttribute: (name: string, force?: boolean) => boolean }
  /** `document.hidden`. */
  hidden: () => boolean
  /** Calls the listener when the page is shown or hidden; returns the way to stop. */
  onVisibility: (listener: () => void) => () => void
}

/** Idle is: out of sight. */
export function windowIdle(state: { hidden: boolean }): boolean {
  return state.hidden
}

/** Keeps the attribute in step with the page; returns the way to stop (and to take the attribute off). */
export function watchWindowIdle(deps: WindowIdleDeps): () => void {
  const apply = () => void deps.root.toggleAttribute(WINDOW_IDLE_ATTRIBUTE, windowIdle({ hidden: deps.hidden() }))
  const stop = deps.onVisibility(apply)
  apply()
  return () => {
    stop()
    deps.root.toggleAttribute(WINDOW_IDLE_ATTRIBUTE, false)
  }
}

/** The real page. */
export function watchRealWindowIdle(): () => void {
  return watchWindowIdle({
    root: document.documentElement,
    hidden: () => document.hidden,
    onVisibility: (listener) => {
      document.addEventListener("visibilitychange", listener)
      return () => document.removeEventListener("visibilitychange", listener)
    },
  })
}
