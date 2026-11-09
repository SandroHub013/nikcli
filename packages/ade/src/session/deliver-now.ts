/**
 * The way out when ADE no longer recognises an agent's box.
 *
 * A CLI update can change what the box looks like (`session/composer.ts`). Then nothing is ever ready, and mail waits for
 * every session of that agent. A box read wrongly as holding a line does the same, in silence. Waiting is the safe side, and
 * it would stop the team's work on an update. So the pane offers one action, «Consegna ora», to the person who can see the
 * screen: one click, one message, typed with its Enter on what is showing then, and the action goes. Never by itself.
 *
 * Only with mail held for 30 s, on a box not recognised or a line in it that does not move, where the reading sees no menu
 * and no turn is going for what ADE knows. On a menu it reads, a trust dialog included, it never shows: there the answer is
 * the menu's. The bytes do not come into it: Claude Code at rest writes every 20 s, and silence would never come.
 *
 * Where the cursor says a dialog the reading does not know, a click would answer it: a plan approved, a question submitted.
 * There the wait is five minutes, and not never: a CLI may come to hide its cursor at rest.
 */

import { STALE_BUSY_MS, type Activity } from "./mailbox"
import { OUTPUT_CLAIM_MAX_MS } from "./output-activity"

export const DELIVER_NOW_AFTER_MS = 30_000
export const DELIVER_NOW_OVER_DIALOG_MS = 5 * 60_000
/** A click whose message did not go by then says nothing about the screen later. */
const ARMED_FOR_MS = 10_000
/** No round has found mail held for this long: the mail has gone, by whatever road. */
const HELD_LAPSE_MS = 5_000

export interface BlindHold {
  /** The box is not there or holds a line, the reading sees no menu, and no turn is going: ADE cannot say what waits. */
  blind: boolean
  /** The line in the box, as `composerLine` reads it: one that changes is being written. */
  line?: string
  /** The cursor says a dialog is up, though no menu reads (`cursorSaysDialog`). */
  dialog?: boolean
}

export type DeliverNowChange = "offered" | "withdrawn" | undefined

/**
 * Whether a turn is going, for what ADE knows: the hook's word where there is one, for as long as a busy is believed
 * anywhere; else a line ADE saw go, for as long as a turn is believed. A pane still starting says `working` and has seen no
 * line: its first task is what starts a turn.
 */
export function turnKnown(input: {
  activity?: Activity
  working: boolean
  workingSince?: number
  now: number
}): boolean {
  if (input.activity) return input.activity.state === "busy" && input.now - input.activity.at < STALE_BUSY_MS
  return input.working && input.workingSince !== undefined && input.now - input.workingSince < OUTPUT_CLAIM_MAX_MS
}

interface HeldMail {
  since: number
  lastAt: number
  line?: string
  dialogSince?: number
  from: Set<string>
  /** Who has heard of it. Every line to a sender is a turn it pays for: once per message, however often the action comes back. */
  told: Set<string>
}

const lineChanged = (entry: HeldMail, hold: BlindHold) =>
  hold.line !== undefined && entry.line !== undefined && hold.line !== entry.line

const waitedEnough = (entry: HeldMail, hold: BlindHold, now: number) =>
  hold.dialog
    ? entry.dialogSince !== undefined && now - entry.dialogSince >= DELIVER_NOW_OVER_DIALOG_MS
    : now - entry.since >= DELIVER_NOW_AFTER_MS

export function createDeliverNow() {
  const held = new Map<string, HeldMail>()
  const offered = new Set<string>()
  const armed = new Map<string, number>()
  /** Clicked, and its line still on its way: the note and the button stay, or their rows going back resize the pane under its Enter. */
  const typing = new Set<string>()

  const drop = (paneId: string): DeliverNowChange => {
    held.delete(paneId)
    return offered.delete(paneId) ? "withdrawn" : undefined
  }
  const withdraw = (paneId: string): DeliverNowChange => (offered.delete(paneId) ? "withdrawn" : undefined)
  /** A menu or a turn: the wait starts again when it has gone, and the mail is still the same mail. */
  const startAgain = (paneId: string, entry: HeldMail, now: number): DeliverNowChange => {
    entry.since = now
    delete entry.dialogSince
    return withdraw(paneId)
  }
  const isArmed = (paneId: string, now: number) => {
    const at = armed.get(paneId)
    return at !== undefined && now - at < ARMED_FOR_MS
  }

  return {
    /** A round found mail held for this pane. `from`: who sent it, told when the action is offered. */
    mailHeld(paneId: string, hold: BlindHold, now: number, from?: string): DeliverNowChange {
      const known = held.get(paneId)
      const entry: HeldMail =
        known && now - known.lastAt <= HELD_LAPSE_MS
          ? known
          : { since: now, lastAt: now, from: new Set(), told: new Set() }
      held.set(paneId, entry)
      entry.lastAt = now
      if (from) entry.from.add(from)
      if (!hold.blind) return startAgain(paneId, entry, now)
      if (hold.dialog) entry.dialogSince ??= now
      else delete entry.dialogSince
      const written = lineChanged(entry, hold)
      if (hold.line !== undefined) entry.line = hold.line
      if (written) entry.since = now
      if (written || !waitedEnough(entry, hold, now)) return withdraw(paneId)
      if (offered.has(paneId) || isArmed(paneId, now)) return undefined
      offered.add(paneId)
      return "offered"
    },
    /** What stands on an offered pane now, each round: the action goes when the mail has gone, the line has moved or a dialog has opened. */
    review(paneId: string, hold: BlindHold, now: number): DeliverNowChange {
      const entry = held.get(paneId)
      if (!entry || now - entry.lastAt > HELD_LAPSE_MS) return drop(paneId)
      if (!hold.blind) return startAgain(paneId, entry, now)
      return lineChanged(entry, hold) || !waitedEnough(entry, hold, now) ? withdraw(paneId) : undefined
    },
    /** The click. True when one message may now go: a menu that has come since takes it back. */
    click(paneId: string, menuNow: boolean, now: number): boolean {
      if (!offered.delete(paneId) || menuNow) return false
      armed.set(paneId, now)
      return true
    },
    armed: (paneId: string, now: number) => isArmed(paneId, now),
    /** The line that uses the click, which then is spent: the next message waits like any other, from the start. */
    take(paneId: string, now: number): boolean {
      if (!isArmed(paneId, now)) return false
      armed.delete(paneId)
      held.delete(paneId)
      typing.add(paneId)
      return true
    },
    /** The line of the click has been dealt with, gone or not. */
    typed(paneId: string): void {
      typing.delete(paneId)
    },
    /** The clicks that have run out with no message gone: said once. The mail's next round offers the action again. */
    lapsed(now: number): string[] {
      const gone = [...armed.keys()].filter((paneId) => !isArmed(paneId, now))
      for (const paneId of gone) armed.delete(paneId)
      return gone
    },
    offered: (paneId: string) => offered.has(paneId),
    offeredPanes: () => [...offered],
    /** The panes that keep the action's row: offered, or clicked until its line has been typed. */
    standing: () => [...new Set([...offered, ...armed.keys(), ...typing])],
    /** Who has not yet heard of the mail held for this pane, and from now on has. */
    untold(paneId: string): string[] {
      const entry = held.get(paneId)
      if (!entry) return []
      const fresh = [...entry.from].filter((from) => !entry.told.has(from))
      for (const from of fresh) entry.told.add(from)
      return fresh
    },
    forget(paneId: string): DeliverNowChange {
      armed.delete(paneId)
      typing.delete(paneId)
      return drop(paneId)
    },
  }
}
