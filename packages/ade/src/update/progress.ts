/**
 * What the updater has done so far, as the Rust side reports it on the
 * `ade-update-progress` event (see `src-tauri/src/update.rs`).
 */
export type UpdateProgress =
  | { phase: "download"; downloaded: number; total: number | null }
  | { phase: "install" }

/** The event name the Rust side emits on. */
export const UPDATE_PROGRESS_EVENT = "ade-update-progress"

/** Megabytes with one decimal, in the language's own digits: "3,8" in Italian, "3.8" in English. */
export function formatMb(bytes: number, locale: string): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / 1_000_000)
}

/** 0–100 when the size is known; `undefined` keeps the bar indeterminate. */
export function progressPercent(progress: UpdateProgress | undefined): number | undefined {
  if (!progress) return undefined
  if (progress.phase === "install") return 100
  if (!progress.total || progress.total <= 0) return undefined
  return Math.min(100, Math.floor((progress.downloaded / progress.total) * 100))
}

/** Reads one event payload; anything shaped differently is ignored rather than drawn. */
export function parseUpdateProgress(payload: unknown): UpdateProgress | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const value = payload as { phase?: unknown; downloaded?: unknown; total?: unknown }
  if (value.phase === "install") return { phase: "install" }
  if (value.phase === "download" && typeof value.downloaded === "number") {
    return { phase: "download", downloaded: value.downloaded, total: typeof value.total === "number" ? value.total : null }
  }
  return undefined
}
