/**
 * Whether ADE is being looked at, as one attribute on the root: `data-window-idle` is there while the window has no
 * focus or is hidden, and the sheet pauses every animation under it (`index.css`).
 *
 * The page cannot tell by itself. WebView2 leaves `document.hidden` false for a window behind another one, so the
 * sweep of every working pane, the haloes, the spinners and a waiting permission's blink went on repainting at 60 fps
 * for as long as ADE was covered, while the vial and the logo, which read the window's focus, had stopped (full review
 * 2026-10-06, sessions 11). The focus is the one the vial reads: Tauri's, where there is Tauri, the DOM's elsewhere.
 * Nothing runs while it is idle: a paused CSS animation costs no frames, and this only listens.
 */

export const WINDOW_IDLE_ATTRIBUTE = "data-window-idle"

export interface WindowIdleDeps {
  root: { toggleAttribute: (name: string, force?: boolean) => boolean }
  /** `document.hidden`. */
  hidden: () => boolean
  /** Whether the window has the focus now. */
  focused: () => boolean | Promise<boolean>
  /** Calls the listener with the window's focus as it changes; returns the way to stop. */
  onFocus: (listener: (focused: boolean) => void) => () => void
  /** Calls the listener when the page is shown or hidden; returns the way to stop. */
  onVisibility: (listener: () => void) => () => void
}

/** Idle is: out of sight, or without the focus. */
export function windowIdle(state: { focused: boolean; hidden: boolean }): boolean {
  return state.hidden || !state.focused
}

/** Keeps the attribute in step with the window; returns the way to stop (and to take the attribute off). */
export function watchWindowIdle(deps: WindowIdleDeps): () => void {
  let focused = true
  let live = true
  const apply = () => {
    if (live) deps.root.toggleAttribute(WINDOW_IDLE_ATTRIBUTE, windowIdle({ focused, hidden: deps.hidden() }))
  }
  const stops = [
    deps.onFocus((next) => {
      focused = next
      apply()
    }),
    deps.onVisibility(apply),
  ]
  // The state at the start may take a moment to be known (Tauri answers asynchronously): until it is, the window counts
  // as in use, so a window that opens in front never flashes paused.
  void Promise.resolve(deps.focused())
    .then((now) => {
      focused = now
      apply()
    })
    .catch(() => {})
  apply()
  return () => {
    live = false
    for (const stop of stops) stop()
    deps.root.toggleAttribute(WINDOW_IDLE_ATTRIBUTE, false)
  }
}

/** The real window: Tauri's focus where there is Tauri, the page's own focus in the browser harness. */
export function watchRealWindowIdle(): () => void {
  let stopTauri: (() => void) | undefined
  let disposed = false
  const tauri = "__TAURI_INTERNALS__" in window
  const stop = watchWindowIdle({
    root: document.documentElement,
    hidden: () => document.hidden,
    focused: async () => {
      if (!tauri) return typeof document.hasFocus === "function" ? document.hasFocus() : true
      const { getCurrentWindow } = await import("@tauri-apps/api/window")
      return getCurrentWindow().isFocused()
    },
    onFocus: (listener) => {
      if (!tauri) {
        const gained = () => listener(true)
        const lost = () => listener(false)
        window.addEventListener("focus", gained)
        window.addEventListener("blur", lost)
        return () => {
          window.removeEventListener("focus", gained)
          window.removeEventListener("blur", lost)
        }
      }
      void import("@tauri-apps/api/window")
        .then(async ({ getCurrentWindow }) => {
          const unlisten = await getCurrentWindow().onFocusChanged(({ payload }) => listener(payload))
          if (disposed) unlisten()
          else stopTauri = unlisten
        })
        .catch(() => {})
      return () => stopTauri?.()
    },
    onVisibility: (listener) => {
      document.addEventListener("visibilitychange", listener)
      return () => document.removeEventListener("visibilitychange", listener)
    },
  })
  return () => {
    disposed = true
    stop()
  }
}
