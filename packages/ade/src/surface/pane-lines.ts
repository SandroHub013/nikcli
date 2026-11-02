import type { TranscriptLine } from "../grid/pane"

/**
 * A pane's transcript, written once per chunk of output and not once per line.
 *
 * Every line a program printed wrote the store, so every line redrew the transcript's `<For>`, moved 200 array slots
 * through the store's proxy, re-armed the autosave and ran each effect that follows a pane. A chunk of a flood is
 * 256 KB, about 2500 lines: the page took 34 s on these writes and 0.2 s in xterm for 10 MiB, one block after another,
 * and no key reached any pane until it was over (live test of 2026-11-02, E2).
 *
 * The search for a question waits for the end of the chunk too, and in a chunk longer than any screen it reads only the
 * last `WATCHED_TAIL` lines. A question is asked and then the program waits, so one with hundreds of lines after it in
 * the same 16 ms is no longer being asked. A chunk of `yes` is 85,000 lines, and that search per line blocked the page
 * for 0.6 s at a time, a key in another pane with it (live test of 2026-11-02, E2).
 */
export const WATCHED_TAIL = 256

export interface LineWriter<T> {
  /** Writes a line now, or at the end of the chunk being read. */
  add(paneId: string, line: T): void
  /** Has a raw line searched for a question now, or at the end of the chunk being read if it is among its last. */
  watch(paneId: string, raw: string): void
  /** Runs `read`, and writes everything it added once `read` is over, pane by pane. */
  together(read: () => void): void
}

export function createLineWriter<T>(
  write: (paneId: string, lines: T[]) => void,
  search: (paneId: string, raw: string) => void = () => {},
): LineWriter<T> {
  let held: Map<string, T[]> | undefined
  let heldRaw: Map<string, string[]> | undefined
  return {
    watch(paneId, raw) {
      if (!heldRaw) return search(paneId, raw)
      const lines = heldRaw.get(paneId)
      if (!lines) return void heldRaw.set(paneId, [raw])
      lines.push(raw)
      // Cut now and then rather than at each line: only the tail is ever read.
      if (lines.length >= WATCHED_TAIL * 2) lines.splice(0, lines.length - WATCHED_TAIL)
    },
    add(paneId, line) {
      if (!held) return write(paneId, [line])
      const lines = held.get(paneId)
      if (lines) lines.push(line)
      else held.set(paneId, [line])
    },
    together(read) {
      if (held) return read()
      const mine = new Map<string, T[]>()
      const mineRaw = new Map<string, string[]>()
      held = mine
      heldRaw = mineRaw
      try {
        read()
      } finally {
        // A line that blew up on the detectors does not take the ones read before it away.
        held = undefined
        heldRaw = undefined
        for (const [paneId, lines] of mine) {
          // Solid runs effects inside this write: a broken one hides no question and takes no other pane's lines.
          try {
            write(paneId, lines)
          } catch (error) {
            console.error("[ADE] a chunk's lines could not be written:", error)
          }
        }
        for (const [paneId, lines] of mineRaw) {
          for (const raw of lines.slice(-WATCHED_TAIL)) {
            try {
              search(paneId, raw)
            } catch (error) {
              console.error("[ADE] a line could not be searched for a question:", error)
            }
          }
        }
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
