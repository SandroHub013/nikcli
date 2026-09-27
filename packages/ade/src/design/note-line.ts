/**
 * A variant's name as the card shows it, next to its number.
 *
 * This file also made the line «Aggiungi alla nota» wrote from the browser
 * pane's Design mode; that mode is gone with the one sheet of a proposal
 * (notifiche-design), and the name is what is left of it.
 */

/**
 * A name that starts with the variant's own number («1 · A linea») without
 * it: the card already says the number (D2 review, BASSO 2). Another number
 * («2 · Vetro» on variant 1, «12 colonne») is part of the name.
 */
export function withoutNumber(name: string, variant: number): string {
  return name.replace(new RegExp(`^${variant}(?:\\s*[·.:)\\-–—]\\s*|$)`), "")
}
