/**
 * The line «Aggiungi alla nota» adds to a proposal's note (D2).
 *
 * In Design mode the browser pane does not send the selection to a session:
 * it writes where it is, as one line in the note of the answer the user is
 * composing, `Variante 2 «Vetro» · h1.title «Il titolo…»: più grande`. The
 * note goes to the agent with the answer, so what the page says passes through
 * `field` (no control characters, no line breaks, bounded): the page is the
 * agent's, but the line is the user's.
 */

import { field } from "../browser/element-context"

/** The part of a selector a person reads: the last piece, or the last two, not the whole `nth-of-type` chain. */
export function shortSelector(selector: string): string {
  const pieces = String(selector ?? "")
    .split(/\s*>\s*/)
    .map((piece) => piece.trim())
    .filter(Boolean)
  const lastTwo = pieces.slice(-2).join(" > ")
  const short = lastTwo.length <= 80 ? lastTwo : (pieces.at(-1) ?? "")
  return field(short, 80)
}

/**
 * A name that starts with the variant's own number («1 · A linea») without
 * it: the line already says «Variante 1» (D2 review, BASSO 2). Another
 * number («2 · Vetro» on variant 1, «12 colonne») is part of the name.
 */
function withoutNumber(name: string, variant: number): string {
  return name.replace(new RegExp(`^${variant}(?:\\s*[·.:)\\-–—]\\s*|$)`), "")
}

export interface NoteLineInput {
  /** The variant's number, from 1. */
  readonly variant: number
  /** The variant's name, e.g. «Vetro». */
  readonly name?: string
  readonly elements: readonly { readonly selector: string; readonly innerText?: string }[]
  /** What the user typed; empty is allowed, and then the line only says where. */
  readonly instruction: string
}

export function noteLine(input: NoteLineInput): string {
  const name = withoutNumber(field(input.name, 60), input.variant)
  const head = name ? `Variante ${input.variant} «${name}»` : `Variante ${input.variant}`
  const selectors = input.elements.map((element) => shortSelector(element.selector)).filter(Boolean)
  // The text says which one only when there is one: with several, the selectors do.
  const text = input.elements.length === 1 ? field(input.elements[0]!.innerText, 60) : ""
  const where = [selectors.join(", "), text ? `«${text}»` : ""].filter(Boolean).join(" ")
  const instruction = field(input.instruction, 400)
  const line = where ? `${head} · ${where}` : head
  return instruction ? `${line}: ${instruction}` : line
}

/** `note` with `line` on a line of its own at the end; what was written stays as it was. */
export function appendNoteLine(note: string, line: string): string {
  if (!line) return note
  if (!note) return line
  return note.endsWith("\n") ? `${note}${line}` : `${note}\n${line}`
}
