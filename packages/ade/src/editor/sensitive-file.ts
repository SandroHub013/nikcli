/**
 * Whether a file pane is covered whole during a take (D68, audit of 0.7.7).
 *
 * The field covers of `record/sensitive.ts` reached the editor only by luck —
 * its `aria-label` carries the path, so `secrets.json` was covered and `.env`
 * was not — and the markdown preview and the viewers never. The terminal's rule
 * is turned the same way here: a file is covered for its name, or for any line
 * the terminal's reader would blur. A lockfile full of hashes is covered too,
 * and that is the right direction to be wrong in.
 */
import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js"
import { rowIsClean } from "../terminal/recording-cover"

/** How often, at most, a file being typed into is read again whole during a take. */
export const JUDGE_EVERY_MS = 300

/** The names secrets are kept under, matched on the file name alone. */
const SECRET_FILE_NAMES = [
  /^\.env/i,
  /\.(?:pem|key|p12|pfx)$/i,
  // A private SSH key: `id_rsa`, `id_ed25519`. `id_rsa.pub` is the public half.
  /^id_[^.]*$/,
  /^\.(?:npmrc|netrc|pypirc|git-credentials)$/i,
  /credential/i,
  /secret/i,
]

export function fileIsSensitive(path: string, text: string | undefined): boolean {
  const name = path.split(/[\\/]/).pop() ?? path
  if (SECRET_FILE_NAMES.some((rule) => rule.test(name))) return true
  return (text ?? "").split(/\r?\n/).some((line) => !rowIsClean(line))
}

/** What a file pane shows, as the cover sees it. */
export interface CoverState {
  path: string
  /** Undefined while the file is still loading. */
  text: string | undefined
  /** Whether a take is covering secrets. */
  covering: boolean
}

/**
 * When the pane is judged: "off" outside a take, "now" when what it shows is
 * new, "throttle" only while a text it already showed is typed into.
 *
 * "Now" is judged inside the effect, before the frame is drawn. It used to be
 * throttled too, and the first judgement ran while the file was still loading:
 * `config.ts` was clean by its name, the text arrived a few ms later, the
 * throttle put it off for up to 300 ms, and a `DB_PASS=` line was filmed for
 * twelve frames (audit 0.7.7, R2).
 */
export function whenToJudge(before: CoverState | undefined, after: CoverState): "off" | "now" | "throttle" {
  if (!after.covering) return "off"
  // The take begins.
  if (!before?.covering) return "now"
  if (before.path !== after.path) return "now"
  // The text arrives, or there is none yet: the name alone is cheap to read.
  if (before.text === undefined || after.text === undefined) return "now"
  return "throttle"
}

/**
 * Whether the lines `after` changed from `before` hold one the terminal's reader
 * would blur. Only those lines are read, so it is cheap enough for every
 * keystroke: a secret pasted into a clean file is covered at once, not when the
 * throttle comes round.
 */
export function changedLinesAreSensitive(before: string, after: string): boolean {
  if (before === after) return false
  let start = 0
  const shortest = Math.min(before.length, after.length)
  while (start < shortest && before[start] === after[start]) start++
  let end = 0
  while (end < shortest - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++
  // Widen to whole lines of the new text.
  const from = after.lastIndexOf("\n", start - 1) + 1
  const newline = after.indexOf("\n", after.length - end)
  const to = newline === -1 ? after.length : newline
  return after
    .slice(from, Math.max(from, to))
    .split(/\r?\n/)
    .some((line) => !rowIsClean(line))
}

/**
 * Whether a file pane is covered now. Judged at once whenever what it shows is
 * new (`whenToJudge`); while it is typed into, the changed lines are checked at
 * once and the whole file at most every `JUDGE_EVERY_MS`. Outside a take it is
 * not read at all. Call inside a component or a root.
 */
export function createFileCover(state: Accessor<CoverState>): Accessor<boolean> {
  const [sensitive, setSensitive] = createSignal(false)
  let before: CoverState | undefined
  let judgedAt = 0
  let pending: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    clearTimeout(pending)
    pending = undefined
  }
  const judge = (path: string, text: string | undefined) => {
    stop()
    judgedAt = Date.now()
    setSensitive(fileIsSensitive(path, text))
  }
  createEffect(() => {
    const after = state()
    const when = whenToJudge(before, after)
    const previous = before?.text ?? ""
    before = after
    if (when === "off") {
      stop()
      return setSensitive(false)
    }
    if (when === "now") return judge(after.path, after.text)
    if (!untrack(sensitive) && changedLinesAreSensitive(previous, after.text ?? "")) setSensitive(true)
    if (pending) return
    const wait = judgedAt + JUDGE_EVERY_MS - Date.now()
    if (wait <= 0) return judge(after.path, after.text)
    // Read what is there when the timer fires, not what was there when it was set.
    pending = setTimeout(() => {
      const latest = before
      if (latest?.covering) judge(latest.path, latest.text)
    }, wait)
  })
  onCleanup(stop)
  return sensitive
}
