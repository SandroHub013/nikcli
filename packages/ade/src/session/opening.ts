/**
 * When to type the opening task into a session that has just started.
 *
 * The task is typed, not passed as an argument — that is deliberate and it is
 * what makes one code path work for eleven different CLIs. But it used to be
 * typed on a fixed timer: 900 ms after spawn, whatever was on screen. Measured
 * on this machine, five of the nine installed agents take longer than that to
 * answer `--version`, which is the cheapest thing they can possibly do — no
 * TUI, no model catalogue, no auth refresh:
 *
 *     claude 60ms · pi 493 · agy 664 · codex 683 · opencode 1093
 *     kimi 1377 · ragu 1912 · gemini 2398 · hermes 22954
 *
 * So for most of the catalogue the text landed in a buffer nobody was reading
 * yet, or — worse — the carriage return answered the first question the CLI
 * asked. "Do you trust the files in this folder?" is a yes/no prompt, and an
 * opening task ending in Enter is an answer to it.
 *
 * What replaces the timer is not a longer timer. A CLI is ready when it has
 * said something and then stopped saying things; the only complication is that
 * a CLI with an animated prompt never stops, so there are two ways to be
 * ready and a session takes whichever comes first.
 */

import type { ComposerState } from "./composer"
import { stripAnsi } from "./stream"

/** How long the output must stay quiet before the screen counts as drawn. */
export const OPENING_QUIET_MS = 400

/**
 * How long after the first byte to give up on waiting for quiet.
 *
 * Ink and ratatui prompts animate — a spinner repaints every ~80 ms and never
 * goes quiet at all — so quiescence alone would wait forever for exactly the
 * agents this is for. Past this point the screen is as drawn as it is going
 * to get.
 */
export const OPENING_SETTLE_MS = 2_500

/**
 * How long to wait for the very first byte before giving up entirely.
 *
 * Generous because one installed agent takes 23 seconds to print its version.
 * A session that produces nothing at all inside this window is not slow, it is
 * broken, and typing into it would only hide that.
 */
export const OPENING_TIMEOUT_MS = 60_000

export interface OpeningInput {
  /** When the process was spawned. */
  startedAt: number
  /** When the first thing was drawn, if anything has been (`bytesAfter`). */
  firstByteAt?: number
  /** When the most recent byte arrived after that. */
  lastByteAt?: number
  /** Now. */
  now: number
  /** True while the session is holding a question the user has not answered. */
  permissionPending: boolean
  /**
   * The user has sent a line in this pane since the session started: counted from the keys, never read off the screen
   * (`submitsLine`). The opening is not typed over what they are already saying to the agent.
   */
  userSpoke?: boolean
  /** The spawn this opening belongs to has no open request any more: cancelled, or answered by other means. */
  requestGone?: boolean
  quietMs?: number
  settleMs?: number
  timeoutMs?: number
}

/**
 * `wait` — not yet; ask again later.
 * `send` — the screen has settled, type it.
 * `abandon` — nothing came, or nothing settled; do not type, and say so (`openingStep` for a first task).
 * `drop` — the opening is no longer wanted: type nothing, ever, and say why (`openingDropReason`).
 */
export type OpeningDecision = "wait" | "send" | "abandon" | "drop"

/**
 * Why an opening is not typed at all: the user has already written to the agent, or the request it carries is closed.
 *
 * Property: ADE never types into an agent uninvited. The opening waits for a screen that is ready, and a screen can read
 * ready in the middle of the user's own turn (a box that is empty while the agent works), so readiness is not permission to
 * type. The user's line comes first, and a cancelled request is a task nobody wants done any more.
 */
export function openingDropReason(input: Pick<OpeningInput, "userSpoke" | "requestGone">): "user" | "request" | undefined {
  if (input.userSpoke) return "user"
  if (input.requestGone) return "request"
  return undefined
}

/**
 * Whether an Enter that sent a line (`submitsLine`) is the user speaking to the agent, for the opening's sake.
 *
 * Text and Enter in a window are not: a login code in a startup dialog, a «1» sent to a menu, a search typed into a picker
 * are for the window, and the opening still goes once it is answered. So an Enter that ADE sees going to a window does not
 * count, and only on a positive sighting: `windowKnown` is a detector's yes (a question open, a trust dialog), never a
 * screen that merely reads nothing, because a screen can lag behind xterm and a real line sent then must still count.
 *
 * An agent's own box, `ready` or `draft`, is where the Enter goes, whatever else is on screen: that is the line of live
 * test 11 (agy's box reads draft at rest, the user types and sends), and it always counts.
 */
export function enterIsUsersLine(input: {
  /** `submitsLine`: an Enter that sent something typed. */
  sendsLine: boolean
  /** The agent's box as the screen reads it; undefined for an agent whose box ADE does not know. */
  box: ComposerState | undefined
  /** A detector positively sees a window at this Enter: a question open (hook, menu, dialog) or a folder-trust dialog. */
  windowKnown: boolean
}): boolean {
  if (!input.sendsLine) return false
  if (input.box === "ready" || input.box === "draft") return true
  return !input.windowKnown
}

export function decideOpening(input: OpeningInput): OpeningDecision {
  // Before everything else, a pending question included: what is dropped is never typed, whenever the screen is ready.
  if (openingDropReason(input)) return "drop"

  const quietMs = input.quietMs ?? OPENING_QUIET_MS
  const settleMs = input.settleMs ?? OPENING_SETTLE_MS
  const timeoutMs = input.timeoutMs ?? OPENING_TIMEOUT_MS

  const waitedFromSpawn = input.now - input.startedAt
  if (input.firstByteAt === undefined) {
    // Silence from a process that has not spoken once. It is starting, or it
    // has already failed; either way there is nothing to type into.
    return waitedFromSpawn >= timeoutMs ? "abandon" : "wait"
  }

  /*
   * Never type into a question.
   *
   * This is the failure the fixed timer actually produced, and it is the one
   * worth being stubborn about: a pending permission means the cursor is
   * sitting on a yes/no prompt, and the first character of an opening task
   * would answer it. It waits for as long as the question stands, and not
   * until a deadline: giving up lost the task of a session that sat on a
   * dialog for a minute, and the user answers when they answer. The caller
   * says in the pane what it waits for.
   */
  if (input.permissionPending) return "wait"

  if (screenDrawn(input, input.now, quietMs, settleMs)) return "send"

  return waitedFromSpawn >= timeoutMs ? "abandon" : "wait"
}

/** What a session's bytes have said so far: see `bytesAfter`. */
export interface OpeningBytes {
  firstByteAt?: number
  lastByteAt?: number
}

/**
 * Whether a chunk puts anything on the screen, as against modes, a title, cursor moves, queries and blanks.
 *
 * `stripAnsi` takes only the introducer of a string sequence and leaves its payload: opentui's queries before its first
 * frame (`ESC P +q4d73 ESC \`, `ESC _ Gi=31337... ESC \`) and ncurses' `ESC ( B` would read as the CLI having drawn. So
 * those go first. A sequence split across two chunks still reads as text.
 */
export function drawsText(chunk: string): boolean {
  const bare = chunk.replace(/\x1b[P^_X][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b[()#][0-9A-Za-z]/g, "")
  return /[^\s\x00-\x1f\x7f]/.test(stripAnsi(bare))
}

/**
 * The byte times after a chunk.
 *
 * The clock starts at the first thing drawn. ConPTY speaks before the program does, about 100 ms after spawn: its modes,
 * the title, the cursor. Counted as the CLI having spoken, a program that took a second to start had the task typed on a
 * blank screen, and what it opened on read it from the console's input: reading the screen could not help, with nothing
 * on it. After the first text every byte counts, a spinner's included.
 *
 * The limit that stays: a program that prints a banner, is quiet for `OPENING_QUIET_MS`, and only then opens a menu gets
 * the task after the banner. Waiting longer on every session would not close it, only move it.
 */
export function bytesAfter(bytes: OpeningBytes, chunk: string, now: number): OpeningBytes {
  const firstByteAt = bytes.firstByteAt ?? (drawsText(chunk) ? now : undefined)
  return firstByteAt === undefined ? bytes : { firstByteAt, lastByteAt: now }
}

/**
 * Whether the screen is as drawn as it is going to get: it has gone quiet or, since an animated prompt never does, it
 * has had long enough to draw whatever it is going to draw.
 */
export function screenDrawn(
  bytes: OpeningBytes,
  now: number,
  quietMs = OPENING_QUIET_MS,
  settleMs = OPENING_SETTLE_MS,
): boolean {
  if (bytes.firstByteAt === undefined) return false
  return now - (bytes.lastByteAt ?? bytes.firstByteAt) >= quietMs || now - bytes.firstByteAt >= settleMs
}

/**
 * The opening's times for a session that has stood on a question, last seen at `menuAt`.
 *
 * The clock starts again from there, all of it. A program redraws after an answer, so it gets the quiet and the settle
 * it had at the start; and the deadline counts from there too, or a question answered more than `OPENING_TIMEOUT_MS`
 * after spawn gave the task up on the first pass after the answer, with its sender told it would arrive.
 */
export function clockAfterMenu(
  times: OpeningBytes & { startedAt: number },
  menuAt: number | undefined,
): OpeningBytes & { startedAt: number } {
  if (menuAt === undefined) return times
  return {
    startedAt: Math.max(times.startedAt, menuAt),
    firstByteAt: times.firstByteAt === undefined ? undefined : Math.max(times.firstByteAt, menuAt),
    lastByteAt: times.lastByteAt === undefined ? undefined : Math.max(times.lastByteAt, menuAt),
  }
}

/** How long a step of a remote session may wait on a question before the pane says it has not been typed. */
export const REMOTE_STEP_NOTE_MS = 180_000

/**
 * What a first task's poll does with a decision. `tell`: say once, in the pane and to the sender, that the deadline has
 * passed with nothing drawn, and go on waiting.
 *
 * With the clock at the first text the deadline can be reached: a CLI slow to start, behind Defender or on a loaded
 * machine, lost its task just as it began to draw. A session that comes late gets its task. The poll ends by itself when
 * the process exits. A program already drawing when the deadline comes has nothing to be told about: its settle is near.
 */
export function openingStep(
  decision: OpeningDecision,
  told: boolean,
  bytes: OpeningBytes,
): "wait" | "tell" | "send" | "drop" {
  if (decision === "abandon") return told || bytes.firstByteAt !== undefined ? "wait" : "tell"
  return decision
}
