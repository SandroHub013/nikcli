/*
 * What Escape and Tab do in the settings panel, by how it is shown.
 *
 * Standalone, the panel is its own dialog: Escape closes it and Tab wraps
 * inside it. Framed, the host draws the dialog around it (ADE's Sheet, on
 * Kobalte), and the host's dialog owns both: the panel only keeps the
 * Escapes that are its own — the one that stops a shortcut being recorded
 * and the one that disarms «Ripristina» — and must claim them before the
 * host sees them, or the dialog closes under the recorder.
 */

export type PanelFrame = "standalone" | "framed" | "inline"

export interface PanelEscapeState {
  readonly frame: PanelFrame
  /** A shortcut field is recording. */
  readonly recording: boolean
  /** «Ripristina» is armed, waiting for its second press. */
  readonly resetArmed: boolean
  /** The panel has somewhere to close to. */
  readonly closable: boolean
}

/** `stop-recording` and `disarm` are claimed (preventDefault): the host must not close on them. */
export type PanelEscape = "stop-recording" | "disarm" | "close" | "host"

export function panelEscape(state: PanelEscapeState): PanelEscape {
  if (state.recording) return "stop-recording"
  if (state.resetArmed) return "disarm"
  if (state.frame === "standalone" && state.closable) return "close"
  return "host"
}

/** Only a standalone panel traps Tab itself; a framed one is inside the host's trap. */
export function panelTrapsTab(frame: PanelFrame): boolean {
  return frame === "standalone"
}

/**
 * Where the panel listens. Framed, on the document in the capture phase, so
 * its own Escapes are claimed before the host's dialog (listening on the
 * document, bubbling) decides to close; standalone, on the window, as ever.
 */
export function panelListensEarly(frame: PanelFrame): boolean {
  return frame === "framed"
}

export function panelFrame(props: { readonly inline?: boolean; readonly framed?: boolean }): PanelFrame {
  if (props.inline) return "inline"
  return props.framed ? "framed" : "standalone"
}
