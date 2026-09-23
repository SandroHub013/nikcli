/**
 * The terminal during a take (D68): every row blurred, except the rows just
 * judged clean.
 *
 * `record/sensitive.ts` covers secret fields by their shape, and said what it
 * could not reach: the terminal, whose lines match no net. Here the net is
 * turned round. The CSS in `index.css` blurs every row of `.xterm-rows` under
 * `html[data-ade-recording]`; a row is shown only when it carries
 * `data-ade-clean`, and only this reader puts it there. So the reader failing,
 * not running, or not understanding a row all end the same way: the row stays
 * blurred.
 *
 * xterm 6 draws with its DOM renderer here (no WebGL addon is loaded), so each
 * visible row is a `div` child of `.xterm-rows`. A `MutationObserver` callback
 * runs as a microtask after the DOM changed and before the frame is painted:
 * no frame shows a new row with an old verdict.
 */
import { SECRET_EXACT_WORDS, SECRET_PREFIXES, SECRET_WORDS } from "../record/sensitive"

export const CLEAN_ATTRIBUTE = "data-ade-clean"

let rules: RegExp[] | undefined

/*
 * How a password is named in a shell, and only there: `DB_PASS`, `MYSQL_PWD`.
 * Not in `SECRET_WORDS`, which also picks the fields to cover by name, where
 * `pass` would cover «passo» and «bypass» too. Here it is a whole name or the
 * last word of one, so `bypass=1` stays clean.
 */
const TERMINAL_PASSWORD_NAMES = ["passwd", "pass", "pwd"]

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/*
 * Built on first use, not at load: `sensitive.ts` imports the registry, which
 * imports this file, and at load the lists may not be there yet.
 */
function secretRules(): RegExp[] {
  if (rules) return rules
  const words = SECRET_WORDS.map(escape).join("|")
  const exact = SECRET_EXACT_WORDS.map(escape).join("|")
  const prefixes = SECRET_PREFIXES.map(escape).join("|")
  rules = [
    // A token that starts the way a real key is printed: `sk-ant-…`, `ghp_…`, `eyJ…`.
    new RegExp(`(?:^|[^A-Za-z0-9_])(?:${prefixes})[A-Za-z0-9_\\-.]{4,}`),
    // A credential's name given a value: `API_KEY=…`, `token: …`, `Authorization: Bearer …`.
    new RegExp(`[A-Za-z0-9_-]*(?:${words})[A-Za-z0-9_-]*["']?\\s*[:=]\\s*\\S`, "i"),
    new RegExp(`(?:^|[^A-Za-z0-9_])(?:${exact})["']?\\s*[:=]\\s*\\S`, "i"),
    new RegExp(`(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9_-]*_)?(?:${TERMINAL_PASSWORD_NAMES.join("|")})["']?\\s*[:=]\\s*\\S`, "i"),
    // A password inside a URL: `postgresql://admin:…@`, `https://user:…@github.com`.
    /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
    /-----BEGIN/,
  ]
  return rules
}

/**
 * A run of 32 or more base64, base64url or hex characters with no space: the
 * body of a PEM key, a key with no known prefix, a JWT. It has to hold a digit
 * and a letter, so a long word or a run of dashes is not one; a long commit
 * hash is, and that is the right direction to be wrong in.
 */
function hasLongOpaqueRun(text: string): boolean {
  for (const run of text.match(/[A-Za-z0-9+/=_-]{32,}/g) ?? []) {
    if (/[0-9]/.test(run) && /[A-Za-z]/.test(run)) return true
  }
  return false
}

/** Whether a logical line of the terminal may be filmed. */
export function rowIsClean(text: string): boolean {
  if (hasLongOpaqueRun(text)) return false
  return !secretRules().some((rule) => rule.test(text))
}

/** The part of xterm's buffer the reader needs: little enough to fake in a test. */
export interface CoverBuffer {
  readonly viewportY: number
  getLine(y: number): { readonly isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined
}

/**
 * The logical line buffer row `y` belongs to: the rows the width wrapped,
 * joined, so a key cut in two is judged whole.
 */
export function logicalLine(buffer: CoverBuffer, y: number): { first: number; last: number; text: string } {
  let first = y
  let last = y
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--
  while (buffer.getLine(last + 1)?.isWrapped) last++
  let text = ""
  for (let row = first; row <= last; row++) text += buffer.getLine(row)?.translateToString(row === last) ?? ""
  return { first, last, text }
}

/** What a drawn row says, in the buffer's terms. */
const drawn = (row: Element) => (row.textContent ?? "").replace(/ /g, " ").trimEnd()

/**
 * Judges the rows `touched` and every row of their logical lines.
 *
 * The mark comes off first, so an error part-way leaves a row blurred, never
 * shown on an old verdict. A row whose drawing does not match the buffer (the
 * buffer moved on, the viewport scrolled) is not judged: it stays blurred until
 * the next paint, which brings it back here.
 */
export function judgeRows(
  container: Element,
  buffer: CoverBuffer,
  touched: Iterable<Element>,
  isClean: (text: string) => boolean = rowIsClean,
): void {
  const rows = Array.from(container.children)
  const lines = new Map<number, { first: number; last: number; text: string }>()
  for (const row of touched) {
    row.removeAttribute(CLEAN_ATTRIBUTE)
    const index = rows.indexOf(row)
    if (index < 0) continue
    const line = logicalLine(buffer, buffer.viewportY + index)
    lines.set(line.first, line)
  }
  for (const line of lines.values()) {
    const shown: Element[] = []
    for (let y = line.first; y <= line.last; y++) {
      const row = rows[y - buffer.viewportY]
      if (row) shown.push(row)
    }
    for (const row of shown) row.removeAttribute(CLEAN_ATTRIBUTE)
    try {
      const faithful = shown.every((row) => {
        const y = buffer.viewportY + rows.indexOf(row)
        return drawn(row) === (buffer.getLine(y)?.translateToString(true) ?? "").trimEnd()
      })
      if (!faithful || !isClean(line.text)) continue
      for (const row of shown) row.setAttribute(CLEAN_ATTRIBUTE, "")
    } catch {
      // Not understood: left blurred.
    }
  }
}

/** The row `node` is part of: a direct child of the rows container. */
function rowOf(container: Element, node: Node): Element | undefined {
  let current: Node | null = node
  while (current && current.parentNode !== container) current = current.parentNode
  return current instanceof Element ? current : undefined
}

/**
 * Keeps judging the rows of one terminal while a take runs. Every visible row
 * is judged at once; the returned function stops, and takes the marks off.
 */
export function watchRows(
  container: Element,
  buffer: () => CoverBuffer,
  isClean: (text: string) => boolean = rowIsClean,
): () => void {
  const judge = (touched: Iterable<Element>) => {
    try {
      judgeRows(container, buffer(), touched, isClean)
    } catch {
      for (const row of touched) row.removeAttribute(CLEAN_ATTRIBUTE)
    }
  }
  const observer = new MutationObserver((records) => {
    const touched = new Set<Element>()
    for (const record of records) {
      if (record.target === container) {
        // Rows added or removed: every row may now sit on another buffer line.
        for (const row of Array.from(container.children)) touched.add(row)
        continue
      }
      const row = rowOf(container, record.target)
      if (row) touched.add(row)
    }
    judge(touched)
  })
  observer.observe(container, { childList: true, subtree: true, characterData: true })
  judge(Array.from(container.children))
  return () => {
    observer.disconnect()
    for (const row of Array.from(container.children)) row.removeAttribute(CLEAN_ATTRIBUTE)
  }
}

/**
 * Whether a selection reaches a line that is blurred on screen: copying it
 * would put the secret, in the clear, wherever it is pasted next. Rows are
 * 0-based buffer rows.
 */
export function selectionReachesSecret(buffer: CoverBuffer, startRow: number, endRow: number, isClean = rowIsClean): boolean {
  for (let y = startRow; y <= endRow; y++) {
    const line = logicalLine(buffer, y)
    if (!isClean(line.text)) return true
    y = Math.max(y, line.last)
  }
  return false
}
