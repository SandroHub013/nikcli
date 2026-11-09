/**
 * Whether each pane's program has bracketed paste on, read from the mode switches in its own output (SES-14).
 *
 * The switch is a sequence, `ESC [ ? 2004 h` (on) or `ESC [ ? 2004 l` (off), and a chunk of output can end in the
 * middle of one: `ESC [ ? 20` in one chunk and `04 h` in the next. Reading each chunk alone missed it, so a paste
 * went in as typing (a pasted newline sent the line) or inside markers a program that had turned the mode off printed.
 * The last few characters of each pane's output are kept, so a sequence split between two chunks is whole again.
 *
 * Several modes can be set at once (`ESC [ ? 1049 ; 2004 h`): the list is searched for 2004.
 */

/** Long enough for the longest switch that matters: `ESC [ ? 1049 ; 2004 h` is 13 characters. */
const TAIL = 16

const SWITCH = /\u001b\[\?([\d;]+)([hl])/g

export function createPasteModes() {
  const modes = new Map<string, boolean>()
  const tails = new Map<string, string>()

  return {
    /** Takes a chunk of the pane's output: the mode changes if the chunk (with the end of the last one) switches it. */
    note(id: string, chunk: string) {
      const text = (tails.get(id) ?? "") + chunk
      // The last switch that names 2004 wins. One wholly inside the old tail is the latest state too, so reading it
      // again is harmless.
      let latest: boolean | undefined
      for (const match of text.matchAll(SWITCH)) {
        if (match[1]!.split(";").includes("2004")) latest = match[2] === "h"
      }
      if (latest !== undefined) modes.set(id, latest)
      tails.set(id, text.slice(-TAIL))
    },
    /** Whether the pane's program has bracketed paste on. Off until it says so. */
    on(id: string): boolean {
      return modes.get(id) === true
    },
    /** The pane is gone: its mode and the tail of its output with it. */
    forget(id: string) {
      modes.delete(id)
      tails.delete(id)
    },
  }
}
