/**
 * The Enter ADE presses after a line it typed, and what came of the line.
 *
 * A permission prompt reads the next Enter as its answer and confirms the
 * choice that is selected (audit 0.7.7, B1 and B1 bis). Every line ADE types
 * waits between the text and its Enter — up to 2.5 s while a CLI takes a paste
 * in — and a prompt can open in that wait. So the check is made at the
 * moment of the Enter, not when the line was queued, and in one place: the
 * line's own Enter and the one `confirmSubmitted` sends again both go
 * through `pressEnter`.
 */

/**
 * What became of a line.
 *
 * `typed-no-enter`: the text is in the input box and the Enter was held back
 * by a prompt. It counts as given — typing it again would put it in the box
 * twice — and the panes say it is waiting for an Enter.
 */
export type LineOutcome = "sent" | "typed-no-enter" | "not-typed"

/** Whether the text reached the input box, sent or not. What a caller counts as given. */
export function lineGiven(outcome: LineOutcome): boolean {
  return outcome !== "not-typed"
}

/** Presses Enter unless a permission prompt is open right now; says whether it did. */
export function pressEnter(write: (data: string) => void, permissionOpen: () => boolean): boolean {
  if (permissionOpen()) return false
  write("\r")
  return true
}

/**
 * A line as `typeLineNow` types it: the text, the wait, then the Enter.
 *
 * The prompt is asked about before the text too: a line waits in the pane's
 * queue, sometimes seconds behind another, and a prompt that opened meanwhile
 * would get the text in its answer box. Then nothing is written and the line
 * is `not-typed` (audit 0.7.7, B1 bis, MEDIO 1). `alive` is asked after the
 * wait: a session gone meanwhile gets no Enter.
 *
 * `typedDuring` too, after the wait: the user who starts writing in the 2.5 to
 * 8 s between ADE's text and its Enter would have their half line sent with
 * it (review area 2). The Enter is held, as for a prompt, and the text stays.
 *
 * `write` answers false when the pane refused the bytes: its queue is full, or
 * its pipe broke. Text refused is `not-typed`, with no Enter: an Enter on its own
 * would submit whatever is in the box, and the message would count as delivered.
 * An Enter refused leaves the text in the box, `typed-no-enter`.
 */
export async function typeThenEnter(input: {
  text: string
  write: (data: string) => unknown
  wait: () => Promise<void>
  alive: () => boolean
  permissionOpen: () => boolean
  typedDuring?: () => boolean
  /** Where the agent's box can be read: what became of the text in it (`textInBox`). */
  textShown?: () => Promise<TextInBox>
  /** What stops the Enter, when that is not what stopped the text: a box with the text in it is no longer empty. */
  enterBlocked?: () => boolean
}): Promise<LineOutcome> {
  if (input.permissionOpen()) return "not-typed"
  const taken = input.write(input.text)
  await input.wait()
  if ((await taken) === false) return "not-typed"
  if (!input.alive()) return "not-typed"
  if (input.typedDuring?.()) return "typed-no-enter"
  if (input.textShown) {
    const shown = await input.textShown()
    if (!input.alive() || shown === "empty") return "not-typed"
    if (shown === "stuck" || input.typedDuring?.()) return "typed-no-enter"
  }
  const entered: unknown[] = []
  const pressed = pressEnter((data) => void entered.push(input.write(data)), input.enterBlocked ?? input.permissionOpen)
  if (!pressed || (await entered[0]) === false) return "typed-no-enter"
  return "sent"
}

/**
 * What became of a line's text in the agent's box.
 *
 * `shows`: the box stopped being empty. That is the sign, and not the text seen again: a long paste shows as «[Pasted text
 * #1 +3 lines]», a long line wraps, runs out of the box or is redrawn by opentui.
 * `empty`: the box is there and empty, so the text went nowhere: no Enter, and the mail goes back in the queue.
 * `stuck`: the box has not come back in time, with the text perhaps in it. The Enter goes no further, and the pane and the
 * sender are told.
 */
export type TextInBox = "shows" | "empty" | "stuck"

/** How long an empty box may take to show a text whose paste has settled. */
export const TEXT_SHOWS_WITHIN_MS = 3_000
/** How long an Enter waits for a box that a dialog has covered: the user answers when they answer, but not for ever. */
export const ENTER_PATIENCE_MS = 120_000
/** The read's own pace: at most four times a second, and nothing per chunk. */
export const BOX_READ_MS = 250

export async function textInBox(input: {
  read: () => "ready" | "draft" | "none"
  /** The session has gone, or the user has begun typing: the caller decides, and nothing more is read. */
  stop: () => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<TextInBox> {
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const from = now()
  let emptyFrom: number | undefined
  while (!input.stop()) {
    const box = input.read()
    if (box === "draft") return "shows"
    emptyFrom = box === "ready" ? (emptyFrom ?? now()) : undefined
    if (emptyFrom !== undefined && now() - emptyFrom >= TEXT_SHOWS_WITHIN_MS) return "empty"
    if (now() - from >= ENTER_PATIENCE_MS) return "stuck"
    await sleep(BOX_READ_MS)
  }
  return "shows"
}

/**
 * How long a line may stand still in the box after its Enter. An agent empties the box at once: the live test saw a line
 * stay for minutes, with the pane idle and nobody told. Past this it is said, and never pressed again: what became of the
 * Enter is not known, and a second one could land on whatever came next.
 */
export const LINE_STAYS_MS = 10_000
/** How long the box must stay without a line for the line to have gone: a repaint or a resize covers it for a moment. */
const LINE_GONE_MS = 1_000

/** Whether the line in the box, as `read` gives it, has stood still for `LINE_STAYS_MS`. False if it went, or on `stop`. */
export async function lineStays(input: {
  /** The line in the box, or undefined with none in it. */
  read: () => string | undefined
  /** The session has gone, or the user has begun typing: nothing to say. */
  stop: () => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<boolean> {
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let line = input.read()
  let since = now()
  let goneSince: number | undefined
  while (!input.stop()) {
    const current = input.read()
    if (current === undefined) {
      goneSince ??= now()
      if (now() - goneSince >= LINE_GONE_MS) return false
    } else {
      goneSince = undefined
      if (current !== line) {
        line = current
        since = now()
      }
      if (now() - since >= LINE_STAYS_MS) return true
    }
    await sleep(BOX_READ_MS)
  }
  return false
}

/**
 * What a delivery made of its line.
 *
 * `held`: not typed while the session is still there — a prompt was open —
 * so the message goes back among the held ones and comes on a later round.
 * It used to be answered as "the session closed during delivery" (MEDIO 1).
 * A line whose text is already in the inbox counts as given: the inbox rings
 * for it again, and typing the message again would deliver it twice.
 */
export type DeliveryResult = "given" | "held" | "closed"

export function deliveryResult(outcome: LineOutcome, alive: boolean, stored = false): DeliveryResult {
  if (lineGiven(outcome)) return "given"
  if (!alive) return "closed"
  return stored ? "given" : "held"
}

/**
 * The Enter ADE presses again, on its own: the resend of `confirmSubmitted`
 * and the re-ring of a request whose line sits in the box.
 *
 * Not while the user is writing: the Enter would send their line half done
 * (MEDIO 2). Not over a prompt, as for every Enter (B1 bis). And in the pane's
 * line queue, like every line, so it cannot fall between another line's text
 * and its Enter (MEDIO 3). True when it was pressed.
 */
export function enterAgain(input: {
  queue: <T>(key: string, job: () => Promise<T>) => Promise<T>
  key: string
  write: (data: string) => void
  alive: () => boolean
  typing: () => boolean
  permissionOpen: () => boolean
}): Promise<boolean> {
  return input.queue(input.key, async () => {
    if (!input.alive() || input.typing()) return false
    return pressEnter(input.write, input.permissionOpen)
  })
}

/**
 * A re-ring, counted before the Enter so the next round does not ring twice
 * while this one waits in the queue, and given back when no Enter went — a
 * draft or a prompt stopped it — so a skipped ring does not use one up.
 * The count goes back to what it was, which is 0 on the first ring.
 */
export async function ringAgain(
  request: { rings?: number },
  press: () => Promise<boolean>,
  save: () => void,
): Promise<boolean> {
  const before = request.rings ?? 0
  request.rings = before + 1
  save()
  const pressed = await press()
  if (!pressed) {
    request.rings = before
    save()
  }
  return pressed
}
