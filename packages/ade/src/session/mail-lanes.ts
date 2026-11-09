/**
 * Who waits behind whom in ADE's mail.
 *
 * The delivery loop was one pass that awaited every message in turn. A `close`
 * removing a worktree or a `spawn --worktree` held it for minutes, and every
 * `ade-msg kv` behind them hit the client's 10 s and printed «ADE non ha
 * risposto» (2026-10-30). A promise that never settled stopped the mail for good,
 * with nothing on screen.
 *
 * So a message waits only behind the ones it could really collide with. Each
 * lane walks its messages in queue order, one at a time, as the old pass did
 * (a message that stays queued does not hold back the next); different lanes
 * never wait for each other, and a message with no lane runs at once. Every
 * message has a deadline: past it the sender gets an error, the lane goes on, and
 * whatever the step does later no longer counts.
 *
 * Plain `.ts`, so these rules can be tested under `bun test`. `workbench.tsx`
 * supplies what delivering a message actually means.
 */

import type { Message } from "./mailbox"

/**
 * Whether a signal of the native side runs a round. Mail in the outbox always does. The pulse a second does on a hidden
 * page, minimised or covered, whose timers Chromium slows to one a minute; a visible page has its 700 ms timer.
 */
export const pulseRuns = (mailWaiting: boolean, hidden: boolean): boolean => mailWaiting || hidden

/** A step that only touches ADE's own state and one file. */
export const MAIL_QUICK_MS = 30_000
/**
 * Typing a line (its paste, then up to `ENTER_PATIENCE_MS` for its box to come back, behind the lines already queued), or a
 * step that may call git once or twice. Longer than those on purpose: a lane that gave up first told the sender «senza
 * esito» while the text was still in the box, and the same message then ran twice.
 */
export const MAIL_STEP_MS = 150_000
/** `close` and `spawn`: several git calls of up to 120 s, and `git worktree add` of up to 600 s. */
export const MAIL_LONG_MS = 15 * 60_000

/**
 * The lane a message runs in, or undefined when it collides with nothing.
 *
 * `paneOf` resolves what the sender wrote after `to` (a number, a title, an
 * agent) to a pane id; a target it cannot find has no lane, and the delivery
 * answers the error at once.
 */
export function mailLane(message: Message, paneOf: (to: string) => string | undefined): string | undefined {
  switch (message.kind) {
    case "send":
    case "ask":
    // Their keys skip the line queue, and between a line's text and its Enter they would clear the line. A message
    // held for that turn is no obstacle: it returns false at once. Only a line being typed delays them, its Enter included.
    case "interrupt":
    case "relaunch": {
      // Typed in the order they were sent, per pane.
      const pane = paneOf(message.to)
      return pane === undefined ? undefined : `pane:${pane}`
    }
    case "reply":
    case "update":
    case "cancel":
    case "delivered":
      // Two answers to one request: the second must see the first closed it, not overwrite it.
      return `ref:${message.ref}`
    // A close takes the descendants too, so two of them must not reclaim one worktree. A spawn checks its name and
    // limits before the awaits and books after them, may need the path a close is removing, and must not open under
    // a parent being closed.
    case "close":
    case "spawn":
      return "sessions"
    // Read, change, write back.
    case "memory":
      return "memory"
    // Both write `design.jsonl` when the register is the design one.
    case "registro":
      return message.register === "design" ? "design" : "registro"
    case "design":
    case "design-proponi":
    case "design-attendi":
      return "design"
    case "kv":
    case "whoowns":
      return undefined
  }
}

/** How long a message may take before it counts as hung. */
export function mailDeadline(message: Message): number {
  switch (message.kind) {
    case "kv":
    case "reply":
    case "update":
    case "cancel":
    case "delivered":
      return MAIL_QUICK_MS
    case "close":
    case "spawn":
      return MAIL_LONG_MS
    default:
      return MAIL_STEP_MS
  }
}

export interface MailLanesOptions<Item> {
  /** True when the message is finished with, false to leave it queued for the next round. */
  deliver: (item: Item) => Promise<boolean>
  laneOf: (item: Item) => string | undefined
  deadlineOf: (item: Item) => number
  /** The message is finished with: out of the queue. */
  done: (item: Item) => void
  /** It passed its deadline. It is out of the queue too: it must not run a second time. */
  hung: (item: Item, afterMs: number) => void
  /** Its delivery threw. Out of the queue too: it would throw again on every round. */
  failed: (item: Item, error: unknown) => void
}

export interface MailLanes<Item> {
  /** Starts what can start, in order, and returns at once: nothing here waits for a delivery. */
  start: (items: readonly Item[]) => void
  /** Whether this message is being delivered right now. */
  inFlight: (id: string) => boolean
  /** Whether this message passed its deadline: what it says from now on is too late. */
  abandoned: (id: string) => boolean
}

export function createMailLanes<Item extends { id: string }>(options: MailLanesOptions<Item>): MailLanes<Item> {
  const inFlight = new Set<string>()
  const abandoned = new Set<string>()
  const walking = new Set<string>()
  // A walk holds its list from when it started. If `to` then resolves to another pane, the next round runs a message
  // there, and the first walk must not deliver it a second time when it gets to it.
  const finished = new WeakSet<Item>()
  const canStart = (item: Item) => !inFlight.has(item.id) && !abandoned.has(item.id) && !finished.has(item)

  const run = (item: Item): Promise<void> =>
    new Promise<void>((resolve) => {
      const ms = options.deadlineOf(item)
      inFlight.add(item.id)
      let over = false
      const finish = () => {
        over = true
        clearTimeout(timer)
        inFlight.delete(item.id)
        resolve()
      }
      const timer = setTimeout(() => {
        if (over) return
        abandoned.add(item.id)
        finish()
        options.hung(item, ms)
      }, ms)
      Promise.resolve()
        .then(() => options.deliver(item))
        .then(
          (isDone) => {
            if (over) return
            finish()
            if (!isDone) return
            finished.add(item)
            options.done(item)
          },
          (error: unknown) => {
            if (over) return
            finish()
            finished.add(item)
            options.failed(item, error)
          },
        )
    })

  const walk = async (lane: string, items: readonly Item[]) => {
    try {
      for (const item of items) {
        if (canStart(item)) await run(item)
      }
    } finally {
      walking.delete(lane)
    }
  }

  return {
    start(items) {
      const lanes = new Map<string, Item[]>()
      for (const item of items) {
        if (!canStart(item)) continue
        const lane = options.laneOf(item)
        if (lane === undefined) {
          void run(item)
          continue
        }
        if (walking.has(lane)) continue
        const list = lanes.get(lane)
        if (list) list.push(item)
        else lanes.set(lane, [item])
      }
      for (const [lane, list] of lanes) {
        walking.add(lane)
        void walk(lane, list)
      }
    },
    inFlight: (id) => inFlight.has(id),
    abandoned: (id) => abandoned.has(id),
  }
}

/**
 * One part of the mail round, one at a time, with a watchdog.
 *
 * A round that is still going makes the next one a no-op, so a step whose promise
 * never settles used to stop that part for good. Past the deadline the step counts
 * as stuck: `onStuck` is told, once until a round ends in time again, and the next
 * round starts. The old round may still wake up later, so what the steps share must
 * bear that (`dropFrom`).
 */
export function createWatchedStep(deadlineMs: number, onStuck: (afterMs: number) => void) {
  let current: object | undefined
  let told = false
  return (step: () => Promise<unknown>): void => {
    if (current) return
    const mine = {}
    current = mine
    const timer = setTimeout(() => {
      if (current !== mine) return
      current = undefined
      if (told) return
      told = true
      onStuck(deadlineMs)
    }, deadlineMs)
    const ended = () => {
      if (current !== mine) return
      clearTimeout(timer)
      current = undefined
      told = false
    }
    // A step that fails is retried on the next round, as `every` always did.
    void Promise.resolve().then(step).then(ended, ended)
  }
}

/**
 * Takes `item` out of `list`; false when it was gone already.
 *
 * `list.splice(list.indexOf(item), 1)` with an item already gone removes the last
 * entry of the list: someone else's message.
 */
export function dropFrom<T>(list: T[], item: T): boolean {
  const at = list.indexOf(item)
  if (at < 0) return false
  list.splice(at, 1)
  return true
}

/**
 * How long after writing its message `ade-msg` is sure to be still reading the receipt.
 *
 * It polls 50 times, 200 ms apart, from after the write, so it stops at 10 s at the
 * earliest. One second less leaves room for the receipt to be written and read.
 */
export const CLIENT_READS_RECEIPT_MS = 9_000

/** When `ade-msg` made this id: both scripts start it with Unix milliseconds. Undefined for any other id. */
export function sentAt(id: string): number | undefined {
  const stamp = /^(\d{13})-/.exec(id)?.[1]
  return stamp === undefined ? undefined : Number(stamp)
}

/**
 * Whether a `kv lock` comes too late to be granted.
 *
 * A client that printed «ADE non ha risposto» believes it has no lock. Granted
 * later, the lock sits on its key for the whole TTL, held by a session that does
 * not know it holds it, and everyone else is refused. Read from the id, so it needs
 * no new field in the message and holds for a script already on disk.
 */
export function lockCameTooLate(id: string, now: number): boolean {
  const at = sentAt(id)
  return at !== undefined && now - at > CLIENT_READS_RECEIPT_MS
}

/**
 * Whether the client of a message may have stopped reading its receipt.
 *
 * Its id says how old it is, or, for an id with no time in it, when ADE took it. A
 * held message's client was answered «in coda» and went away, however young it is.
 * Every deadline is longer than the client's wait, so a step that hung has always
 * lost its client; a delivery that throws usually has not.
 */
export function clientStoppedReading(input: { id: string; takenAt: number; held: boolean; now: number }): boolean {
  return input.held || input.now - (sentAt(input.id) ?? input.takenAt) > CLIENT_READS_RECEIPT_MS
}

export type HangNotice = "nothing" | "tell" | "settle-and-tell"

/**
 * What else a message ADE gave up on owes its sender, beyond the receipt.
 *
 * Most clients stop reading receipts after their 10 s. Left at that, the session
 * would wait for ever for a reply to a message it believes is on its way, or for a
 * child that never opened.
 */
export function hangNotice(message: { kind: Message["kind"]; wait?: boolean }, clientGone: boolean): HangNotice {
  if (!clientGone) return "nothing"
  switch (message.kind) {
    // Their client has already printed «ADE non ha risposto»: it knows.
    case "kv":
    case "whoowns":
    case "memory":
    case "registro":
    // Its wait reads late receipts.
    case "design-attendi":
      return "nothing"
    // The same with `--attendi`. Without it there is no wait: the client printed «in coda» with exit 0.
    case "design-proponi":
      return message.wait ? "nothing" : "tell"
    // A later `ade-msg wait` needs the result, and the default wait has usually ended by now.
    case "ask":
    case "spawn":
      return "settle-and-tell"
    // Told «in coda» with exit 0: nothing else will ever reach it.
    default:
      return "tell"
  }
}

/**
 * One writer per request. The result is written first and the request closed after,
 * so a `reply` and a `close` in one tick both saw it open, and the last rename won:
 * «richiesta interrotta» over the real answer, with the replier told it was delivered.
 * A second caller writes nothing and gets false, the same as a write that failed.
 */
export function oneSettleAtATime() {
  const going = new Set<string>()
  return async (id: string, work: () => Promise<boolean>): Promise<boolean> => {
    if (going.has(id)) return false
    going.add(id)
    try {
      return await work()
    } finally {
      going.delete(id)
    }
  }
}

/** Per round: how long each part of the mail may take before it counts as stuck (`createWatchedStep`). */
export const MAIL_TAKE_ROUND_MS = 15_000
export const MAIL_MOVE_ROUND_MS = 60_000
/** The watch part may run `git status` for several folders, at up to 120 s each. */
export const MAIL_WATCH_ROUND_MS = 5 * 60_000

export type MailPart = "take" | "move" | "watch"

/**
 * A round of the mail, in three parts that never wait for each other: what came in,
 * what moves, and what only keeps watch. Each has its own watchdog, and none is
 * awaited here, so neither the page timer nor the native signal can be held up by a
 * step that does not end.
 *
 * With no session running, every fourth call runs a round, unless the caller knows
 * mail is waiting (`mailWaiting`, the native signal).
 */
export function createMailRound(options: {
  sessions: () => number
  take: () => Promise<unknown>
  move: () => Promise<unknown>
  watch: () => Promise<unknown>
  onStuck: (part: MailPart, afterMs: number) => void
  /** True while nothing may be taken or typed (an update is installing): neither the timer nor the native signal runs a round. */
  paused?: () => boolean
}): (mailWaiting: boolean) => void {
  const part = (name: MailPart, deadlineMs: number) =>
    createWatchedStep(deadlineMs, (afterMs) => options.onStuck(name, afterMs))
  const take = part("take", MAIL_TAKE_ROUND_MS)
  const move = part("move", MAIL_MOVE_ROUND_MS)
  const watch = part("watch", MAIL_WATCH_ROUND_MS)
  let calls = 0
  return (mailWaiting) => {
    // The installer is about to kill every session: the outbox keeps what arrives meanwhile.
    if (options.paused?.()) return
    calls++
    if (!mailWaiting && options.sessions() === 0 && calls % 4 !== 0) return
    take(options.take)
    move(options.move)
    watch(options.watch)
  }
}
