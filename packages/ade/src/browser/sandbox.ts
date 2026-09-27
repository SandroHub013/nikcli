/**
 * The browser pane's frame: its own origin, for WebGL, forms and popups
 * (fec210d0b). It was one of two: the pane's Design mode loaded a proposal's
 * page with no origin of its own, and that mode is gone with the one sheet of
 * a proposal (notifiche-design), which shows the pages itself.
 */
export const BROWSE_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
