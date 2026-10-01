/**
 * The browser pane's frame: its own origin, for WebGL, forms and popups
 * (fec210d0b). It was one of two: the pane's Design mode loaded a proposal's
 * page with no origin of its own, and that mode is gone with the one sheet of
 * a proposal (notifiche-design), which shows the pages itself.
 */
export const BROWSE_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals"

/**
 * A design sheet's frame (`ade-msg design`, `design/sheet.ts`): scripts and
 * forms, no origin of its own, no popups, no dialogs. The page is an agent's,
 * served from `ade-media`, which serves every file of the open projects: with
 * an origin it could read them. `ade-media` makes it opaque a second time with
 * its CSP (`media.rs`, `DESIGN_SHEET_CSP`).
 */
export const DESIGN_SANDBOX = "allow-scripts allow-forms"
