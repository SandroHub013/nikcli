/**
 * The "where to save the takes" question, asked once at a time.
 *
 * The native folder dialog does not block the page: "Registra la finestra"
 * from the palette opened one, the palette stayed open behind it, and every
 * further Enter opened another — three at once in D78's live test. A call made
 * while a dialog is open now waits for that dialog's answer instead.
 */
export function onePickAtATime<T>(pick: () => Promise<T>): () => Promise<T> {
  let open: Promise<T> | undefined
  return () => {
    open ??= pick().finally(() => {
      open = undefined
    })
    return open
  }
}
