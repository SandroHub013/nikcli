/**
 * What real agents wrote to a real ConPTY, recorded in the live test of 2026-11-03 (`session/fixtures/live`), played
 * through a real xterm. An account and the user's folder are masked at the same length; the rest is byte for byte.
 */
import { Terminal } from "@xterm/xterm"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { watchCursor } from "../session/composer"

export interface Capture {
  /** Epoch ms of the first chunk. */
  start: number
  /** Ms after it, and the chunk as the pane got it. */
  chunks: [number, string][]
}

export function loadCapture(name: string): Capture {
  const url = new URL(`../session/fixtures/live/${name}.json.gz`, import.meta.url)
  return JSON.parse(gunzipSync(readFileSync(url)).toString("utf8")) as Capture
}

const written = (terminal: Terminal, chunk: string) => new Promise<void>((resolve) => terminal.write(chunk, resolve))

/** The rows ConPTY gave the program when it started; a pane resized later is given here by the test. */
export function sizeOf(capture: Capture): { cols: number; rows: number } {
  for (const [, chunk] of capture.chunks) {
    const size = chunk.match(/\x1b\[8;(\d+);(\d+)t/)
    if (size) return { cols: Number(size[2]), rows: Number(size[1]) }
  }
  return { cols: 158, rows: 21 }
}

export function terminalFor(capture: Capture, size?: { cols: number; rows: number }): Terminal {
  const terminal = new Terminal({ ...(size ?? sizeOf(capture)), scrollback: 5000, allowProposedApi: true })
  watchCursor(terminal)
  return terminal
}

/** Every chunk through the terminal; `visit` sees the screen after each, with the chunk's time and the next one's. */
export async function play(
  name: string,
  visit: (terminal: Terminal, at: number, nextAt: number | undefined) => void,
  size?: { cols: number; rows: number },
): Promise<Terminal> {
  const capture = loadCapture(name)
  const terminal = terminalFor(capture, size)
  for (let i = 0; i < capture.chunks.length; i++) {
    const [at, chunk] = capture.chunks[i]!
    await written(terminal, chunk)
    visit(terminal, at, capture.chunks[i + 1]?.[0])
  }
  return terminal
}

/** The whole screen as one string, for telling which frame is which. */
export function screenText(terminal: Terminal): string {
  const screen = terminal.buffer.active
  const rows: string[] = []
  for (let y = 0; y < terminal.rows; y++) rows.push(screen.getLine(screen.baseY + y)?.translateToString(true) ?? "")
  return rows.join("\n")
}

export { written as writtenTo }
