/**
 * The browser pane in Design mode (D1, D83 = A): the pieces with no DOM.
 *
 * A design variant is shown on ADE's media scheme, in a frame whose origin is
 * opaque (`DESIGN_SANDBOX` has no `allow-same-origin`), and inspected there.
 * The pane cannot read an opaque frame's address, so it tells whether the
 * frame is still on the page it was given by counting loads: every load it
 * did not cause — a link followed, a form sent, `location` set by the page, a
 * reload the page did itself — is a new document, and the pane no longer
 * knows what that is. Inspection goes off and stays off until the pane loads
 * the variant again.
 */

/** The frame of an ordinary page: its own origin, for WebGL, forms and popups (fec210d0b). */
export const BROWSE_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals"

/** The frame of a design page: scripts for the inspector, no origin of its own, nothing that leaves the frame. */
export const DESIGN_SANDBOX = "allow-scripts allow-forms"

/** Which variant of which proposal a pane in Design mode shows. */
export interface DesignTarget {
  /** The proposal's key, e.g. `DS-A`. */
  readonly k: string
  /** The variant's number, from 1. */
  readonly variant: number
  /** The page on disk. */
  readonly path: string
  /** The proposal's title, for the address bar. */
  readonly title?: string
  /** The size the page declares in `ade-size`, when it declares one. */
  readonly size?: { readonly width: number; readonly height: number }
  /** The projects open in the window: the only roots `designUrlFor` accepts. */
  readonly roots: readonly string[]
}

export function frameSandbox(design: DesignTarget | undefined): string {
  return design ? DESIGN_SANDBOX : BROWSE_SANDBOX
}

/** What the pane knows of its frame: waiting for the load it caused, and whether the frame has gone elsewhere. */
export interface DesignWatch {
  readonly awaiting: boolean
  readonly left: boolean
}

/** A frame given its `src` on first render: its first load is the pane's own. */
export const INITIAL_DESIGN_WATCH: DesignWatch = { awaiting: true, left: false }

/**
 * `src`: the pane pointed the frame at the variant (a reload included).
 * `load`: the frame finished loading a document, whichever.
 */
export type DesignWatchEvent = { readonly type: "src" } | { readonly type: "load" }

export function watchDesign(state: DesignWatch, event: DesignWatchEvent): DesignWatch {
  if (event.type === "src") return { awaiting: true, left: false }
  if (state.awaiting) return { awaiting: false, left: state.left }
  return { awaiting: false, left: true }
}
