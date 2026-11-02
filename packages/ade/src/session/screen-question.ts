/**
 * The question a pane's screen is asking, read off the terminal itself (audit SES-3).
 *
 * `watchForPermission` reads the line stream: the pty's bytes, ANSI stripped, split on newlines. Codex (ratatui),
 * OpenCode and ragu without its plugin (opentui), and Claude Code's fullscreen TUI place their rows with cursor moves
 * and no newline, so their menus reach the stream as one run-together line and are never seen. The pane then looked
 * quiet and free, and the Enter of a delivery or of an opening task confirmed whatever was selected: «Yes, proceed», or
 * a folder-trust dialog. On the screen the rows are whole, so they are read there.
 *
 * The bottom of the buffer, not the viewport: a program draws what it waits on at the bottom, and the user may have
 * scrolled the view back. Only the screen-drawn menus are added to what the stream finds
 * (`PermissionSchema.screen`); a numbered list in a reply is no menu here either.
 */

import { detectPermission, type PermissionRequest } from "./permission"

export interface ScreenTerminal {
  readonly rows: number
  readonly buffer: {
    readonly active: {
      readonly baseY: number
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined
    }
  }
}

/** The rows at the bottom of the terminal's buffer, as text. */
export function bottomRows(terminal: ScreenTerminal): string[] {
  const screen = terminal.buffer.active
  const rows: string[] = []
  for (let y = 0; y < terminal.rows; y++) rows.push(screen.getLine(screen.baseY + y)?.translateToString(true) ?? "")
  return rows
}

/** The question on `terminal`'s screen, if it is asking one. */
export function screenQuestion(terminal: ScreenTerminal, agentId: string): PermissionRequest | undefined {
  return detectPermission(bottomRows(terminal), agentId, { screen: true })
}
