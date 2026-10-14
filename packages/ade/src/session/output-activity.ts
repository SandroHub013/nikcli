/*
 * Output that says a session is working, for the agents with no turn hooks.
 *
 * Their status comes from the terminal: an Enter, the composer or a delivery set
 * the pane working, and a few quiet seconds set it back. Nothing went the other
 * way, so a turn that began without an Enter ADE saw — a queued message, a
 * scheduled wake-up, an agent carrying on by itself — showed «Disponibile» for
 * as long as it ran, and took mail in the middle of it.
 *
 * Measured on 2026-09-28 in a ConPTY, 120×35, as ADE runs them (OpenCode, pi,
 * Kimi, Grok, agy, Prime): standing at their prompt all six print nothing at all
 * for a minute; a resize or a focus report is one burst inside a single 500 ms
 * window; while they work, a spinner or the streamed text fills every window,
 * the longest gap 375 ms, including through a two-minute tool call. So a run of
 * consecutive windows with output is work, and one burst is a redraw.
 *
 * What the user types is echoed, and a keystroke can redraw the whole prompt:
 * output this close to input is the answer to it, not a turn.
 */

/** The length of one window: longer than the longest gap between a working TUI's frames. */
export const OUTPUT_WINDOW_MS = 500

/** Consecutive windows with output that make a turn: three bursts, where a redraw is one. */
export const WORKING_WINDOWS = 3

/** Output this soon after a keystroke is its echo, or the prompt redrawn around it. */
export const ECHO_MS = 1000

/** Where a pane's run of windows with output stands. */
export interface OutputRun {
  /** The index of the last window that had output. */
  window: number
  /** How many consecutive windows, up to that one, had output. */
  run: number
}

/**
 * The run after a chunk of output arrived at `now`, or `undefined` when the
 * chunk does not count: it came right after something was typed.
 */
export function outputRun(
  previous: OutputRun | undefined,
  now: number,
  inputAt: number | undefined,
): OutputRun | undefined {
  if (inputAt !== undefined && now - inputAt < ECHO_MS) return undefined
  const window = Math.floor(now / OUTPUT_WINDOW_MS)
  if (!previous) return { window, run: 1 }
  if (window === previous.window) return previous
  return { window, run: window === previous.window + 1 ? previous.run + 1 : 1 }
}

/** Whether the run is long enough to be a turn. */
export function outputSaysWorking(run: OutputRun | undefined): boolean {
  return (run?.run ?? 0) >= WORKING_WINDOWS
}

/**
 * How long output alone is believed to be a turn.
 *
 * The rule above reads a turn from the terminal because those agents say nothing else. It is a guess, and a guess
 * has to be able to end: a TUI that is resumed and then repaints for ever — a spinner on a server that is idle —
 * prints in every window, is never quiet, and so stayed `working` (and closed to mail, and deaf to an Esc) for as
 * long as it lived: three hours for the ragu session «Sol 6.1» on 2026-10-14, every message of it complete.
 *
 * So a turn that only output declared, with no keystroke ADE saw, no delivery and no hook behind it, is given up
 * after this long. It is the longest such a turn is believed to run, not a guess at how long turns take: a turn
 * somebody started (an Enter, a message ADE typed) never expires by this rule, and is ended by the quiet that ends
 * every turn. After it expires the pane is quarantined: its output is not read as a turn again until something
 * with evidence starts one, so the status does not flicker back at the next window. A turn that began unseen and
 * runs longer than this is the price: its pane reads free, and mail may arrive in the middle of it.
 */
export const OUTPUT_CLAIM_MAX_MS = 10 * 60_000

/**
 * Which panes' `working` rests on output alone, and which are quarantined from it.
 *
 * Pure bookkeeping, one per workbench: the workbench says when output declared a turn (`noticed`), when something
 * with evidence began one (`evidence`), when an Esc or Ctrl-C ended it (`quarantine`), and asks on every pass
 * which claims have run out (`expire`).
 */
export function createOutputClaims() {
  const claimed = new Map<string, number>()
  const quarantined = new Set<string>()
  return {
    /** Output declared a turn in this pane at `now`: the claim runs from the first time, not from the last. */
    noticed(paneId: string, now: number): void {
      if (!claimed.has(paneId)) claimed.set(paneId, now)
    },
    /** A turn with evidence began, or the user took the pane over: it is not an output claim, and not quarantined. */
    evidence(paneId: string): void {
      claimed.delete(paneId)
      quarantined.delete(paneId)
    },
    /** The claim has run out: true once, then the pane is quarantined. */
    expire(paneId: string, now: number): boolean {
      const since = claimed.get(paneId)
      if (since === undefined || now - since < OUTPUT_CLAIM_MAX_MS) return false
      claimed.delete(paneId)
      quarantined.add(paneId)
      return true
    },
    /** Output is not read as a turn here until something with evidence begins one. */
    quarantined(paneId: string): boolean {
      return quarantined.has(paneId)
    },
    /** An interruption: whatever the output claimed is over, and what it prints next is not a new turn. */
    quarantine(paneId: string): void {
      claimed.delete(paneId)
      quarantined.add(paneId)
    },
    /** The pane was closed or started again. */
    forget(paneId: string): void {
      claimed.delete(paneId)
      quarantined.delete(paneId)
    },
  }
}

/**
 * Stamps every write into a session, and every resize, with the time it was
 * made, so the output that answers it is not taken for work: a divider dragged
 * across the screen is a resize every frame, and a full-screen TUI redraws on
 * each. In place, like `countingLines`: the session is compared by identity
 * elsewhere.
 */
export function stampingInput<
  T extends { write: (data: string) => void; resize?: (cols: number, rows: number) => void },
>(session: T, stamp: () => void): T {
  const write = session.write.bind(session)
  session.write = (data: string) => {
    stamp()
    write(data)
  }
  const resize = session.resize?.bind(session)
  if (resize) {
    session.resize = (cols: number, rows: number) => {
      stamp()
      resize(cols, rows)
    }
  }
  return session
}
