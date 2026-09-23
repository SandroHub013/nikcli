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
 * `alive` is asked after the wait: a session gone meanwhile gets no Enter.
 */
export async function typeThenEnter(input: {
  text: string
  write: (data: string) => void
  wait: () => Promise<void>
  alive: () => boolean
  permissionOpen: () => boolean
}): Promise<LineOutcome> {
  input.write(input.text)
  await input.wait()
  if (!input.alive()) return "not-typed"
  return pressEnter(input.write, input.permissionOpen) ? "sent" : "typed-no-enter"
}
