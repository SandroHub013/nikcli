/**
 * The progress of «Impara», as ADE reads it, checks it and writes it.
 *
 * The lesson page keeps it in a frame with an opaque origin, so it has no `localStorage` of its own: what ADE hands it at the opening
 * comes from `learn_progress_get`, and what it hands back after each answer is checked here before it is written. The shape is the
 * page's (`page/learn.js`), which refuses to run on a version it does not know, so the two ends agree on one number and both refuse
 * anything else.
 */

/** The shape the document is in. Bumped when it changes; the page has its own copy of this number. */
export const PROGRESS_VERSION = 1

/** What an exported file is called, so an imported one is the one thing ADE is willing to read. */
export const EXPORT_NAME = "ade-impara-progress.json"

export interface ExerciseRecord {
  viste: number
  giuste: number
  intervallo: number
  dovuta?: string
}

export interface Progress {
  v: number
  xp: number
  giorni: string[]
  esercizi: Record<string, ExerciseRecord>
}

/** What a learner who has not opened a single lesson has. */
export function emptyProgress(): Progress {
  return { v: PROGRESS_VERSION, xp: 0, giorni: [], esercizi: {} }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isIso = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
const counter = (value: unknown): number => (Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0)

export type Parsed = { ok: true; progress: Progress } | { ok: false; reason: string }

/**
 * Reads a progress out of what the page sent, of what is on disk or of what a file says.
 *
 * A version this code does not know is refused rather than read: a document from a newer ADE, or a file somebody edited, must not be
 * written over with a version that has lost whatever was in it. Within the version, a field that is not what it should be becomes its
 * zero, because losing a month of lessons over one odd value is worse than the odd value.
 */
export function parseProgress(raw: unknown): Parsed {
  if (!isObject(raw)) return { ok: false, reason: "non è un documento" }
  if (raw.v !== PROGRESS_VERSION) return { ok: false, reason: `versione ${String(raw.v)}, questa è la ${PROGRESS_VERSION}` }
  const progress = emptyProgress()
  if (Number.isFinite(raw.xp)) progress.xp = Math.max(0, Math.floor(raw.xp as number))
  if (Array.isArray(raw.giorni)) progress.giorni = [...new Set(raw.giorni.filter(isIso))].sort()
  if (isObject(raw.esercizi)) {
    for (const [id, record] of Object.entries(raw.esercizi)) {
      if (!isObject(record)) continue
      progress.esercizi[id] = {
        viste: counter(record.viste),
        giuste: counter(record.giuste),
        intervallo: Math.min(365, counter(record.intervallo)),
        ...(isIso(record.dovuta) ? { dovuta: record.dovuta } : {}),
      }
    }
  }
  return { ok: true, progress }
}