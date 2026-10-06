import { t } from "../i18n"
/**
 * Modello del buffer dell'editor.
 *
 * Mantiene lo stato di sincronizzazione tra il contenuto su disco (saved)
 * e quello in corso di modifica (draft), gestendo il flag dirty e
 * proteggendo file troncati in lettura da sovrascritture distruttive.
 */

export interface Buffer {
  path: string
  /** Contenuto salvato su disco l'ultima volta che lo abbiamo letto. */
  saved: string
  /** Contenuto corrente nell'editor. */
  draft: string
  /** True quando draft e saved divergono. */
  dirty: boolean
  /** Il file era troncato in lettura: salvarlo distruggerebbe il resto. */
  truncated: boolean
  /**
   * Il fine-riga del file com'era su disco. `saved` e `draft` sono sempre con LF, come li
   * restituisce la textarea; il fine-riga si rimette solo scrivendo (`withEol`).
   */
  eol: Eol
}

export type Eol = "\n" | "\r\n"

/** Il testo con tutti i fine-riga a LF: com'è nella textarea, qualunque fosse su disco. */
export function toLf(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}

/** CRLF quando prevale nel file, altrimenti LF. Un file misto prende il fine-riga più frequente. */
export function eolOf(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/\n/g) ?? []).length - crlf
  return crlf > lf ? "\r\n" : "\n"
}

/** Il testo con LF riscritto nel fine-riga del file. */
export function withEol(text: string, eol: Eol): string {
  return eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text
}

export interface Position {
  line: number
  column: number
}

/**
 * Inizializza un nuovo buffer a partire da un file letto da disco.
 */
export function openBuffer(input: { path: string; text: string; truncated: boolean }): Buffer {
  // Un file CRLF si apre con LF e si salva con CRLF: senza questo la prima modifica riscriveva ogni
  // riga e il diff di git le copriva tutte (revisione completa 2026-10-06, ui 1).
  const text = toLf(input.text)
  return {
    path: input.path,
    saved: text,
    draft: text,
    dirty: false,
    truncated: input.truncated,
    eol: eolOf(input.text),
  }
}

/**
 * Aggiorna il testo corrente in bozza e ricalcola se è stato modificato rispetto a disco.
 */
export function editBuffer(buffer: Buffer, draft: string): Buffer {
  return {
    ...buffer,
    draft,
    dirty: draft !== buffer.saved,
  }
}

/**
 * Registra l'avvenuto salvataggio su disco aggiornando il testo di riferimento.
 */
export function markSaved(buffer: Buffer, savedText: string): Buffer {
  return {
    ...buffer,
    saved: savedText,
    dirty: buffer.draft !== savedText,
  }
}

/**
 * Ripristina il contenuto della bozza all'ultimo testo salvato su disco.
 */
export function revertBuffer(buffer: Buffer): Buffer {
  return {
    ...buffer,
    draft: buffer.saved,
    dirty: false,
  }
}

/**
 * Restituisce il motivo per cui il salvataggio non è consentito, oppure undefined se è possibile procedere.
 * Regola fondamentale: un buffer troncato non può mai essere salvato per evitare perdite di dati.
 */
export function saveBlockedReason(buffer: Buffer): string | undefined {
  if (buffer.truncated) {
    return t("editor.truncatedSave")
  }
  if (!buffer.dirty) {
    return t("editor.nothingToSave")
  }
  return undefined
}

/** Where 1-based `line` begins in `text`; past the end, where the last line begins. */
export function offsetOfLine(text: string, line: number): number {
  let offset = 0
  for (let current = 1; current < line; current++) {
    const next = text.indexOf("\n", offset)
    if (next < 0) break
    offset = next + 1
  }
  return offset
}

/**
 * Calcola il numero totale di righe nel testo.
 */
export function lineCount(text: string): number {
  return text.split("\n").length
}

/**
 * Calcola la posizione 1-based (riga e colonna) all'interno del testo dato un offset in caratteri.
 */
export function positionOf(text: string, offset: number): Position {
  const clamped = Math.max(0, Math.min(offset, text.length))
  const slice = text.slice(0, clamped)
  const lines = slice.split("\n")
  const line = lines.length
  const lastLine = lines[lines.length - 1] ?? ""
  const column = lastLine.length + 1
  return { line, column }
}
