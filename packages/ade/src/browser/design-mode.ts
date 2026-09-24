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
 *
 * A new document asks for the bridge before its `load`, though (the
 * Architect's BASSO 1): on a slow page, a click in between was a selection.
 * So a second ask for one `src` counts as leaving too.
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
  /** The variant's name, for the note line («Vetro»). */
  readonly name?: string
  /** The size the page declares in `ade-size`, when it declares one. */
  readonly size?: { readonly width: number; readonly height: number }
  /** The projects open in the window: the only roots `designUrlFor` accepts. */
  readonly roots: readonly string[]
}

/**
 * What a Design-mode pane does with the proposal (D2), given by its owner:
 * the note and the choice live in the design hub, not in the pane.
 */
export interface DesignActions {
  /** Whether this variant is picked in the answer being composed. */
  readonly picked: boolean
  /** How many variants the proposal has, for the arrows. */
  readonly count: number
  readonly pick: () => void
  readonly step: (delta: -1 | 1) => void
  readonly addToNote: (line: string) => void
}

/** The variant `delta` away from `variant` (from 1), or undefined past either end. */
export function stepVariant(variant: number, delta: -1 | 1, count: number): number | undefined {
  const next = variant + delta
  return next >= 1 && next <= count ? next : undefined
}

export function frameSandbox(design: DesignTarget | undefined): string {
  return design ? DESIGN_SANDBOX : BROWSE_SANDBOX
}

/** What the pane knows of its frame: waiting for the load it caused, and whether the frame has gone elsewhere. */
export interface DesignWatch {
  readonly awaiting: boolean
  readonly left: boolean
  /** A document has asked for the bridge since the pane last set `src`. */
  readonly asked: boolean
}

/** A frame given its `src` on first render: its first load is the pane's own. */
export const INITIAL_DESIGN_WATCH: DesignWatch = { awaiting: true, left: false, asked: false }

/**
 * `src`: the pane pointed the frame at the variant (a reload included).
 * `load`: the frame finished loading a document, whichever.
 * `ask`: a document in the frame asked for the bridge.
 */
export type DesignWatchEvent = { readonly type: "src" } | { readonly type: "load" } | { readonly type: "ask" }

export function watchDesign(state: DesignWatch, event: DesignWatchEvent): DesignWatch {
  if (event.type === "src") return { awaiting: true, left: false, asked: false }
  if (event.type === "ask") return state.asked ? { ...state, left: true } : { ...state, asked: true }
  if (state.awaiting) return { ...state, awaiting: false }
  return { ...state, awaiting: false, left: true }
}
