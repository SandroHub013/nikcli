/**
 * How we would know a CLI's box has changed: the shape of what ADE could not read, kept on this machine.
 *
 * Never the screen's text, which can hold anything, keys included. Letters and digits are masked and the glyphs stay,
 * which is what tells one box from another. The size is bounded and nothing is sent anywhere.
 */

import type { ComposerTerminal } from "./composer"

export const COMPOSER_LOG_KEY = "ade.composerLog"
const MAX_ENTRIES = 40
const MAX_ROW = 120
const MAX_BYTES = 64 * 1024

export type ComposerLogReason =
  /** «Consegna ora» has been offered: nothing on the screen could be read. */
  | "offered"
  /** The box is not there, no menu reads, and the reading of menus alone would have typed. */
  | "no-box-no-menu"
  /** The box is there and empty, over what reads as a menu. */
  | "box-over-menu"

export interface ComposerLogEntry {
  at: number
  agent: string
  reason: ComposerLogReason
  cols: number
  rows: number
  cursor: [number, number]
  /** Row number and masked row, for the rows with something on them. */
  shape: [number, string][]
}

/** A row with its letters as x and its digits as 0. The glyphs of a frame, a prompt and a bar stay whole. */
export function maskRow(row: string): string {
  return row.replace(/\p{L}/gu, "x").replace(/\p{N}/gu, "0").trimEnd().slice(0, MAX_ROW)
}

export function composerLogEntry(
  terminal: ComposerTerminal & { readonly cols: number },
  agent: string,
  reason: ComposerLogReason,
  at: number,
): ComposerLogEntry {
  const screen = terminal.buffer.active
  const shape: [number, string][] = []
  for (let y = 0; y < terminal.rows; y++) {
    const row = maskRow(screen.getLine(screen.baseY + y)?.translateToString(true) ?? "")
    if (row) shape.push([y, row])
  }
  return {
    at,
    agent,
    reason,
    cols: terminal.cols,
    rows: terminal.rows,
    cursor: [screen.cursorX, screen.cursorY],
    shape,
  }
}

const sameShape = (a: ComposerLogEntry, b: ComposerLogEntry) =>
  a.agent === b.agent && a.reason === b.reason && JSON.stringify(a.shape) === JSON.stringify(b.shape)

/** The stored log with `entry` added: a shape already there is not added twice, and the oldest go first. */
export function logWith(stored: string | null, entry: ComposerLogEntry): string {
  let entries: ComposerLogEntry[] = []
  try {
    const parsed: unknown = JSON.parse(stored ?? "[]")
    if (Array.isArray(parsed)) entries = parsed as ComposerLogEntry[]
  } catch {}
  if (entries.some((seen) => sameShape(seen, entry))) return stored ?? "[]"
  entries.push(entry)
  entries = entries.slice(-MAX_ENTRIES)
  let text = JSON.stringify(entries)
  while (text.length > MAX_BYTES && entries.length > 1) {
    entries.shift()
    text = JSON.stringify(entries)
  }
  return text
}
