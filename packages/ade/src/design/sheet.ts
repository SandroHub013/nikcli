/*
 * A design sheet: a page a session wrote in `.ade/design/`, shown in a web pane
 * beside it (`ade-msg design <file>`, the design sheet piece 1).
 *
 * The checks on the file are Rust's (`media.rs`, `design_sheet`): only that
 * side can resolve a link. What is here is what the pane does with a file that
 * passed them — its title, its address, whether one is open already, and when
 * it changed on disk.
 */
import type { DirEntry } from "../host/shell"
import type { ReadDir, WatchedRegister } from "../host/register-watch"
import { mediaUrl } from "../video/video"

/** What a web pane showing a sheet remembers, and keeps across a restart. */
export interface PaneSheet {
  /** The file, as the session's folder spells it. */
  file: string
  /** The session that asked: where the notes go back to. */
  from: string
  /** The pane's title as the session gave it; the file's name without it. */
  title?: string
}

/** The longest title a session may give its sheet. */
export const SHEET_TITLE_MAX = 80

/** A title a pane can carry: one line of plain text, cut at {@link SHEET_TITLE_MAX}. */
export function sheetTitle(raw: string | undefined): string | undefined {
  const clean = (raw ?? "")
    // Control characters, a terminal's escapes among them, and line breaks.
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!clean) return undefined
  return clean.length > SHEET_TITLE_MAX ? `${clean.slice(0, SHEET_TITLE_MAX - 1)}…` : clean
}

/** What the pane is called: the given title, or the file's name. */
export function sheetLabel(sheet: Pick<PaneSheet, "file" | "title">): string {
  return sheet.title ?? sheetName(sheet.file)
}

/** The file's name, whatever the separators. */
export function sheetName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file
}

/** The folder the file is in, for the listing the reload reads. */
export function sheetFolder(file: string): string {
  const cut = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"))
  return cut > 0 ? file.slice(0, cut) : file
}

/** The frame's address: the file on `ade-media`, which the pane otherwise refuses. */
export function sheetUrl(file: string, windows?: boolean): string {
  return windows === undefined ? mediaUrl(file) : mediaUrl(file, windows)
}

/**
 * Whether `url` is this sheet and nothing else: the one `ade-media` address a
 * sheet's pane lets past its refusal of ADE's origins. The query and the
 * fragment are free (a reload adds `__ade_reload`, which `ade-media` ignores);
 * the path is not.
 */
export function isSheetAddress(url: string, file: string, windows?: boolean): boolean {
  const cut = url.search(/[?#]/)
  return (cut < 0 ? url : url.slice(0, cut)) === sheetUrl(file, windows)
}

/** Two spellings of one file: separators unified, case ignored (the folders ADE serves are Windows ones too). */
export function sameSheet(a: string, b: string): boolean {
  const norm = (path: string) => path.replace(/\\/g, "/").toLowerCase()
  return norm(a) === norm(b)
}

/** The pane already showing this file, if there is one: it is reused, not doubled. */
export function sheetPaneFor<P extends { designSheet?: PaneSheet }>(panes: readonly P[], file: string): P | undefined {
  return panes.find((pane) => pane.designSheet && sameSheet(pane.designSheet.file, file))
}

/** A file's size and last write, as a folder listing gives them. */
export interface SheetStamp {
  modified: number
  size: number
}

/**
 * Whether a sheet changed since it was last seen. The first sight is not a
 * change: the pane has just loaded that very file. A file gone from the listing
 * is not one either: the frame keeps what it shows until it comes back.
 */
export function sheetChanged(
  previous: SheetStamp | undefined,
  entry: { modified_ms: number; size: number } | undefined,
): boolean {
  if (!previous || !entry) return false
  return previous.modified !== entry.modified_ms || previous.size !== entry.size
}

/** How long after the last write the frame loads again: an agent writes a file in more than one go. */
export const SHEET_RELOAD_DELAY_MS = 300

export interface SheetWatchOptions {
  /** The panes showing a sheet now. */
  sheets: () => readonly { id: string; file: string }[]
  /** Loads the pane's frame again. */
  reload: (id: string) => void
  /** The timer, replaceable in tests. */
  later?: (run: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
}

/**
 * The reload, as one more register in the pass that already lists `.ade/`
 * (`host/register-watch.ts`): the sheets' folder is listed once for all of them,
 * and a sheet whose size or last write changed loads again
 * {@link SHEET_RELOAD_DELAY_MS} after the last change seen.
 */
export function createSheetWatch(options: SheetWatchOptions): WatchedRegister & { forget: (id: string) => void } {
  const later = options.later ?? ((run, ms) => setTimeout(run, ms))
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  // Keyed on pane and file: a pane that shows another file starts over.
  const stamps = new Map<string, SheetStamp>()
  const pending = new Map<string, unknown>()
  // A pane id has no "|", a path on Windows neither.
  const key = (sheet: { id: string; file: string }) => `${sheet.id}|${sheet.file}`

  const forget = (id: string) => {
    for (const k of [...stamps.keys()]) if (k.startsWith(`${id}|`)) stamps.delete(k)
    const handle = pending.get(id)
    if (handle !== undefined) cancel(handle)
    pending.delete(id)
  }

  const tick = async (listing?: ReadDir) => {
    if (!listing) return
    const sheets = options.sheets()
    const live = new Set(sheets.map(key))
    for (const k of [...stamps.keys()]) if (!live.has(k)) stamps.delete(k)
    for (const sheet of sheets) {
      let entries: DirEntry[]
      try {
        entries = await listing(sheetFolder(sheet.file))
      } catch {
        continue
      }
      const name = sheetName(sheet.file)
      const entry = entries.find((e) => !e.is_dir && sameSheet(e.name, name))
      const k = key(sheet)
      if (sheetChanged(stamps.get(k), entry)) {
        const previous = pending.get(sheet.id)
        if (previous !== undefined) cancel(previous)
        pending.set(
          sheet.id,
          later(() => {
            pending.delete(sheet.id)
            options.reload(sheet.id)
          }, SHEET_RELOAD_DELAY_MS),
        )
      }
      if (entry) stamps.set(k, { modified: entry.modified_ms, size: entry.size })
    }
  }

  return { tick, forget }
}
