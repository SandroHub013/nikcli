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

/*
 * The folder-trust dialog a CLI opens on a folder it has not seen: Claude Code («Do you trust the files in this
 * folder?», «Is this a project you created or one you trust?», «Yes, I trust this folder») and codex («Do you trust
 * the contents of this directory?», «Yes, allow Codex to work in this folder»). Read on the rows joined, so a wrapped
 * sentence still reads.
 */
const TRUST_RE =
  /\b(?:do you trust the (?:files|contents)|one you trust|trust this folder|allow codex to work in this folder)\b/i
// The cursor on the first option, and that option a yes: the Enter that confirms it grants the trust.
const YES_SELECTED_RE = /^\s*[│┃║]?\s*[❯›▶➤]\s*1[.)]\s*yes\b/i

/**
 * Whether `rows` are a folder-trust dialog, and whether its selected answer is the yes. Undefined when the screen
 * asks nothing, or asks something else.
 */
export function folderTrust(rows: readonly string[], agentId: string): { yesSelected: boolean } | undefined {
  if (!detectPermission([...rows], agentId, { screen: true })) return undefined
  if (!TRUST_RE.test(rows.join(" ").replace(/\s+/g, " "))) return undefined
  return { yesSelected: rows.some((row) => YES_SELECTED_RE.test(row)) }
}

/**
 * What the opening task does about a folder-trust dialog it waits behind (review of invio-giusto, point 3).
 *
 * The Enter of an opening task used to answer it unseen. Since SES-3 the task waits, and a session spawned with
 * `--worktree` sat on the dialog until a click came, then gave its task up after a minute. A worktree ADE made for
 * this spawn is a checkout of a project already open in ADE, so there the Enter confirms the trust as before, and
 * only when the yes is the answer selected. Anywhere else the user is told to confirm it in the terminal, and the
 * task waits.
 */
export function openingTrust(trust: { yesSelected: boolean }, ownWorktree: boolean): "accept" | "ask" {
  return ownWorktree && trust.yesSelected ? "accept" : "ask"
}
