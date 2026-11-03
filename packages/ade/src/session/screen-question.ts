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

import {
  confirmDialog,
  detectPermission,
  menuAboveLines,
  permissionIdentity,
  type PermissionRequest,
} from "./permission"

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

/** A question on a screen. `under`: the rows with something on them below it, 0 when it is the last thing on the screen. */
export type ScreenMenu = PermissionRequest & { under: number }

function menuOnRows(rows: readonly string[], agentId: string): ScreenMenu | undefined {
  const dialog = agentId === "ragu" ? confirmDialog(rows) : undefined
  if (dialog) return { ...dialog, under: 0 }
  const last = detectPermission([...rows], agentId, { screen: true })
  if (last) return { ...last, under: 0 }
  const above = menuAboveLines(rows)
  return above && { ...above.request, under: above.under }
}

/** The question on `terminal`'s screen, if it is asking one. */
export function screenQuestion(terminal: ScreenTerminal, agentId: string): ScreenMenu | undefined {
  return menuOnRows(bottomRows(terminal), agentId)
}

/**
 * Whether `menu` says it takes `key`: what one of its answers sends (its number, or ragu's y and n), or the letter a label
 * shows in brackets, «Yes, proceed (y)». Enter is everyone's, and is not asked here.
 */
export function menuNames(menu: PermissionRequest, key: string): boolean {
  const pressed = key.toLowerCase()
  return menu.answers.some(
    (answer) => answer.send.toLowerCase() === pressed || answer.label.toLowerCase().endsWith(`(${pressed})`),
  )
}

/** The menu an Enter was typed into, and how many rows of the screen asked its question. */
interface AnsweredMenu {
  identity: string
  /** One more is a new menu, the same words printed again. */
  copies: number
}

export interface MenuHold {
  /** An Enter on its way to the pane: said before it is written. */
  enterTyped(paneId: string, terminal: ScreenTerminal, agentId: string): void
  /** The menu that waits on the pane's screen now, if one does. */
  waiting(paneId: string, terminal: ScreenTerminal, agentId: string): ScreenMenu | undefined
  forget(paneId: string): void
}

/**
 * Which of the menus on a screen still waits.
 *
 * A menu that is the last thing on the screen waits. One with lines below it may be waiting, or may be one already
 * answered by a program that prints lines and never redraws, so what tells them apart is what the user did:
 *
 * - an Enter into it is its answer, whatever the program does next;
 * - any other key says nothing, a key the menu names included: a digit may answer it or only move the highlight, and a
 *   program that goes on printing under it looks the same either way. The mail's Enter would confirm the highlight;
 * - the same question printed again below the first is a new menu.
 *
 * Time and more output say nothing: a program that waits can go on printing (`mla`), and a timer that let the mail go
 * would be typing into the menu. So a false positive, the words of a menu in a reply with its hint and all, holds mail
 * until the user presses Enter, until it scrolls away, or, where the CLI reports its turns, until the turn is over (the
 * caller's `screenAsks`). So does a program that answers on a digit, never redraws and has not reached its bare prompt.
 * Mail that waits with a note beats an Enter in a menu; the pane and the sender are told why.
 */
export function createMenuHold(): MenuHold {
  const answered = new Map<string, AnsweredMenu>()
  const identityOf = (menu: ScreenMenu) =>
    `${permissionIdentity(menu)}\n${menu.answers.map((answer) => answer.label).join("\n")}`
  // A menu with no question over it goes by its first answer: an empty string is in every row.
  const copiesOf = (rows: readonly string[], menu: ScreenMenu) => {
    const words = menu.what || menu.answers[0]?.label || ""
    return rows.filter((row) => row.includes(words)).length
  }
  return {
    enterTyped(paneId, terminal, agentId) {
      const rows = bottomRows(terminal)
      const menu = menuOnRows(rows, agentId)
      if (menu) answered.set(paneId, { identity: identityOf(menu), copies: copiesOf(rows, menu) })
    },
    waiting(paneId, terminal, agentId) {
      const rows = bottomRows(terminal)
      const menu = menuOnRows(rows, agentId)
      const enter = answered.get(paneId)
      if (!menu) {
        answered.delete(paneId)
        return undefined
      }
      if (!enter) return menu
      if (enter.identity !== identityOf(menu) || copiesOf(rows, menu) > enter.copies) {
        answered.delete(paneId)
        return menu
      }
      return menu.under === 0 ? menu : undefined
    },
    forget(paneId) {
      answered.delete(paneId)
    },
  }
}

/** Chunks given to xterm and not yet parsed, per pane: until they are, the screen says nothing about them. */
export function createUnparsed() {
  const counts = new Map<string, number>()
  return {
    fed(paneId: string) {
      counts.set(paneId, (counts.get(paneId) ?? 0) + 1)
    },
    parsed(paneId: string) {
      const left = (counts.get(paneId) ?? 0) - 1
      if (left > 0) counts.set(paneId, left)
      else counts.delete(paneId)
    },
    behind: (paneId: string) => counts.has(paneId),
    forget(paneId: string) {
      counts.delete(paneId)
    },
  }
}

/**
 * What the pane's status becomes after a reading of its screen.
 *
 * The stream can lose a menu the screen still shows, and take the pane back to working, with a line printed below it.
 * `other`: the stream's request or the hook's permission says the pane waits, whatever this reading says.
 */
export function statusFromScreen(input: {
  waiting: boolean
  /** This reading had the pane waiting last time. */
  wasWaiting: boolean
  status: string | undefined
  other: boolean
}): "waiting" | "working" | undefined {
  if (input.waiting) return input.status === "waiting" ? undefined : "waiting"
  if (input.wasWaiting && input.status === "waiting" && !input.other) return "working"
  return undefined
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
  if (!menuOnRows(rows, agentId)) return undefined
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
