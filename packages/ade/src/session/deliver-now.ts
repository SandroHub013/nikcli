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
 */

import { STALE_BUSY_MS, type Activity } from "./mailbox"
import { OUTPUT_CLAIM_MAX_MS } from "./output-activity"

export const DELIVER_NOW_AFTER_MS = 30_000
/** A click whose message did not go by then says nothing about the screen later. */
const ARMED_FOR_MS = 10_000
/** No round has found mail held for this long: the mail has gone, by whatever road. */
const HELD_LAPSE_MS = 5_000

export interface BlindHold {
  /** The box is not there or holds a line, the reading sees no menu, and no turn is going: ADE cannot say what waits. */
  blind: boolean
  /** The line in the box, as `composerLine` reads it: one that changes is being written. */
  line?: string
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

export function createDeliverNow() {
  const held = new Map<string, { since: number; lastAt: number; line?: string; from: Set<string> }>()
  const offered = new Set<string>()
  const armed = new Map<string, number>()

  const drop = (paneId: string): DeliverNowChange => {
    held.delete(paneId)
    return offered.delete(paneId) ? "withdrawn" : undefined
  }
  const isArmed = (paneId: string, now: number) => {
    const at = armed.get(paneId)
    return at !== undefined && now - at < ARMED_FOR_MS
  }

  return {
    /** A round found mail held for this pane. `from`: who sent it, told when the action is offered. */
    mailHeld(paneId: string, hold: BlindHold, now: number, from?: string): DeliverNowChange {
      if (!hold.blind) return drop(paneId)
      const known = held.get(paneId)
      const entry =
        known && now - known.lastAt <= HELD_LAPSE_MS ? known : { since: now, lastAt: now, from: new Set<string>() }
      held.set(paneId, entry)
      entry.lastAt = now
      if (from) entry.from.add(from)
      const written = hold.line !== undefined && entry.line !== undefined && hold.line !== entry.line
      if (hold.line !== undefined) entry.line = hold.line
      if (written) {
        entry.since = now
        return offered.delete(paneId) ? "withdrawn" : undefined
      }
      if (offered.has(paneId) || isArmed(paneId, now) || now - entry.since < DELIVER_NOW_AFTER_MS) return undefined
      offered.add(paneId)
      return "offered"
    },
    /** What stands on an offered pane now, each round: the action goes when the mail has gone or the line has moved. */
    review(paneId: string, hold: BlindHold, now: number): DeliverNowChange {
      const entry = held.get(paneId)
      const written = hold.line !== undefined && entry?.line !== undefined && hold.line !== entry.line
      if (!entry || !hold.blind || written || now - entry.lastAt > HELD_LAPSE_MS) return drop(paneId)
      return undefined
    },
    /** The click. True when one message may now go: a menu that has come since takes it back. */
    click(paneId: string, menuNow: boolean, now: number): boolean {
      if (!offered.delete(paneId)) return false
      if (menuNow) {
        held.delete(paneId)
        return false
      }
      armed.set(paneId, now)
      return true
    },
    armed: (paneId: string, now: number) => isArmed(paneId, now),
    /** The line that uses the click, which then is spent: the next message waits like any other, from the start. */
    take(paneId: string, now: number): boolean {
      if (!isArmed(paneId, now)) return false
      armed.delete(paneId)
      held.delete(paneId)
      return true
    },
    /** The clicks that have run out with no message gone: said once. The mail's next round offers the action again. */
    lapsed(now: number): string[] {
      const gone = [...armed.keys()].filter((paneId) => !isArmed(paneId, now))
      for (const paneId of gone) armed.delete(paneId)
      return gone
    },
    offered: (paneId: string) => offered.has(paneId),
    offeredPanes: () => [...offered],
    senders: (paneId: string) => [...(held.get(paneId)?.from ?? [])],
    forget(paneId: string): DeliverNowChange {
      armed.delete(paneId)
      return drop(paneId)
    },
  }
}
