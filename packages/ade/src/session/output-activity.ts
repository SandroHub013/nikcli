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
