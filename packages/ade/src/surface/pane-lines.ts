import type { TranscriptLine } from "../grid/pane"

/**
 * A pane's transcript, written once per chunk of output and not once per line.
 *
 * Every line a program printed wrote the store, so every line redrew the transcript's `<For>`, moved 200 array slots
 * through the store's proxy, re-armed the autosave and ran each effect that follows a pane. A chunk of a flood is
 * 256 KB, about 2500 lines: the page took 34 s on these writes and 0.2 s in xterm for 10 MiB, one block after another,
 * and no key reached any pane until it was over (live test of 2026-11-02, E2).
 *
 * The detectors still read each line where it is printed; only the write waits for the end of the chunk.
 */
export interface LineWriter<T> {
  /** Writes a line now, or at the end of the chunk being read. */
  add(paneId: string, line: T): void
  /** Runs `read`, and writes everything it added once `read` is over, pane by pane. */
  together(read: () => void): void
}

export function createLineWriter<T>(write: (paneId: string, lines: T[]) => void): LineWriter<T> {
  let held: Map<string, T[]> | undefined
  return {
    add(paneId, line) {
      if (!held) return write(paneId, [line])
      const lines = held.get(paneId)
      if (lines) lines.push(line)
      else held.set(paneId, [line])
    },
    together(read) {
      if (held) return read()
      const mine = new Map<string, T[]>()
      held = mine
      try {
        read()
      } finally {
        // A line that blew up on the detectors does not take the ones read before it away.
        held = undefined
        for (const [paneId, lines] of mine) write(paneId, lines)
      }
    },
  }
}

/**
 * The transcript with `added` at its end and only the last `max` lines kept, or undefined when nothing is new.
 *
 * A new array rather than a push and a splice on the store's: one write, whatever the transcript's length. A frame
 * redrawn is the same line again, and one entry says as much, across chunks too.
 */
export function withLines(
  current: readonly TranscriptLine[],
  added: readonly TranscriptLine[],
  max: number,
): TranscriptLine[] | undefined {
  const fresh: TranscriptLine[] = []
  let last = current.at(-1)?.text
  for (const line of added) {
    if (line.text === last) continue
    fresh.push(line)
    last = line.text
  }
  if (fresh.length === 0) return undefined
  return [...current, ...fresh].slice(-max)
}
