/**
 * The way out when ADE no longer recognises an agent's box.
 *
 * A CLI update can change what the box looks like (`session/composer.ts`). Then nothing is ever ready, and mail waits for
 * every session of that agent. Waiting is the safe side, and it would stop the team's work on an update. So the pane offers
 * one action, «Consegna ora», to the person who can see the screen: one click, one message, typed with its Enter on what
 * is showing then, and the action goes. Never by itself.
 *
 * Only on a screen that has stood still, where the reading sees no menu. On a menu it reads, a trust dialog included, it
 * never shows: there the answer is the menu's.
 */

export const DELIVER_NOW_AFTER_MS = 30_000
/** A click whose message did not go by then says nothing about the screen later. */
const ARMED_FOR_MS = 10_000
/** No round has found mail held for this long: the mail has gone, by whatever road. */
const HELD_LAPSE_MS = 5_000

export interface BlindHold {
  /** The box is not there and the reading sees no menu: ADE cannot say what the screen is. */
  blind: boolean
  lastOutputAt?: number
}

export type DeliverNowChange = "offered" | "withdrawn" | undefined

const standsStill = (hold: BlindHold, now: number) =>
  hold.lastOutputAt === undefined || now - hold.lastOutputAt >= DELIVER_NOW_AFTER_MS

export function createDeliverNow() {
  const held = new Map<string, { since: number; lastAt: number; from: Set<string> }>()
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
      const entry = held.get(paneId) ?? { since: now, lastAt: now, from: new Set<string>() }
      held.set(paneId, entry)
      entry.lastAt = now
      if (from) entry.from.add(from)
      if (!standsStill(hold, now)) {
        entry.since = now
        return offered.delete(paneId) ? "withdrawn" : undefined
      }
      if (offered.has(paneId) || now - entry.since < DELIVER_NOW_AFTER_MS) return undefined
      offered.add(paneId)
      return "offered"
    },
    /** What stands on an offered pane now, each round: the action goes when the mail has gone or the screen has moved. */
    review(paneId: string, hold: BlindHold, now: number): DeliverNowChange {
      const entry = held.get(paneId)
      if (!entry || !hold.blind || !standsStill(hold, now) || now - entry.lastAt > HELD_LAPSE_MS) return drop(paneId)
      return undefined
    },
    /** The click. True when one message may now go: a menu that has come since takes it back. */
    click(paneId: string, menuNow: boolean, now: number): boolean {
      if (!offered.has(paneId)) return false
      drop(paneId)
      if (menuNow) return false
      armed.set(paneId, now)
      return true
    },
    armed: (paneId: string, now: number) => isArmed(paneId, now),
    /** The line that uses the click, which then is spent: the next message waits like any other. */
    take(paneId: string, now: number): boolean {
      const usable = isArmed(paneId, now)
      armed.delete(paneId)
      return usable
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
