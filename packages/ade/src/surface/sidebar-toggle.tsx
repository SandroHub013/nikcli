import { t } from "../i18n"

/**
 * Showing and hiding the sidebar, so the sessions can have the whole width.
 *
 * Hidden is a choice that outlives a restart, kept beside the column's width
 * (`ade:sidebar:width`). The column is hidden, not unmounted: its file tree,
 * its search and its sections come back as they were left.
 */
export const SIDEBAR_HIDDEN_KEY = "ade:sidebar:hidden"

export function readSidebarHidden(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(SIDEBAR_HIDDEN_KEY) === "true"
  } catch {
    return false
  }
}

export function writeSidebarHidden(storage: Pick<Storage, "setItem" | "removeItem"> | undefined, hidden: boolean) {
  try {
    if (hidden) storage?.setItem(SIDEBAR_HIDDEN_KEY, "true")
    else storage?.removeItem(SIDEBAR_HIDDEN_KEY)
  } catch {
    // Private mode or a full disk: the column still toggles, it is only not remembered.
  }
}

/**
 * The button, in the top bar beside the project's facts.
 *
 * One name for both states, and the state in `aria-pressed` (pressed: the
 * sidebar is shown), as a toggle button is read; the tooltip says what a click
 * will do, with the shortcut.
 */
export function SidebarToggle(props: { hidden: boolean; onToggle: () => void; shortcut?: string }) {
  const tip = () => {
    const action = props.hidden ? t("bar.sidebar.show") : t("bar.sidebar.hide")
    return props.shortcut ? `${action} (${props.shortcut})` : action
  }
  return (
    <button
      type="button"
      data-slot="ade-icon"
      data-action="sidebar"
      aria-label={t("bar.sidebar")}
      aria-pressed={!props.hidden}
      title={tip()}
      onClick={() => props.onToggle()}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.3" />
        <path d="M6.5 3v10" stroke="currentColor" stroke-width="1.3" />
        {/* The column filled while it is on screen, empty while it is hidden. */}
        <rect
          data-slot="sidebar-toggle-column"
          x="3.2"
          y="4.2"
          width="2.6"
          height="7.6"
          rx="1"
          fill="currentColor"
          opacity={props.hidden ? 0 : 0.45}
        />
      </svg>
    </button>
  )
}
