/**
 * The three recording settings the palette commands and the settings panel
 * both keep: quality, microphone, folder.
 *
 * They live in localStorage because they outlive a session and must be read
 * before the workbench exists; both entrances go through these functions so
 * the choice made in Registrazione › Registrazione video and the one made by
 * `record.quality` are the same choice, written the same way.
 */

import { DEFAULT_QUALITY, QUALITY_LEVELS, type RecordQuality } from "./recording"

export const RECORD_DIR_KEY = "ade.record.dir"
export const RECORD_QUALITY_KEY = "ade.record.quality"
export const RECORD_MIC_KEY = "ade.record.mic"

/** A value read from storage, or `undefined` when storage cannot be reached. */
function read(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    // A sandboxed or full store: the default stands in for this session.
    return undefined
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Kept for this session only: a take still records with the choice made.
  }
}

/** The saved folder, or `undefined` when none was ever chosen. */
export function loadRecordDir(): string | undefined {
  return read(RECORD_DIR_KEY)
}

export function saveRecordDir(dir: string): void {
  write(RECORD_DIR_KEY, dir)
}

/** The saved quality, falling back to the default for an unknown value. */
export function loadRecordQuality(): RecordQuality {
  const saved = read(RECORD_QUALITY_KEY)
  return QUALITY_LEVELS.some((level) => level.id === saved) ? (saved as RecordQuality) : DEFAULT_QUALITY
}

export function saveRecordQuality(quality: RecordQuality): void {
  write(RECORD_QUALITY_KEY, quality)
}

/** The microphone flag: off until switched on, like a fresh install. */
export function loadRecordMic(): boolean {
  return read(RECORD_MIC_KEY) === "on"
}

export function saveRecordMic(on: boolean): void {
  write(RECORD_MIC_KEY, on ? "on" : "off")
}

/**
 * The next quality in the palette's cycle.
 *
 * `record.quality` rotates through the levels rather than opening a submenu;
 * the settings panel offers the same list as choices and both walk it in the
 * same order.
 */
export function cycleQuality(current: RecordQuality): RecordQuality {
  const order = QUALITY_LEVELS.map((level) => level.id)
  return order[(order.indexOf(current) + 1) % order.length] ?? DEFAULT_QUALITY
}
