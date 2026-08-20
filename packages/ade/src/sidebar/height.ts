export const DEFAULT_SESSIONS_HEIGHT = 200
export const MIN_SESSIONS_HEIGHT = 100
export const MAX_SESSIONS_HEIGHT = 600

export function clampSessionsHeight(
  height: number,
  min = MIN_SESSIONS_HEIGHT,
  max = MAX_SESSIONS_HEIGHT,
): number {
  const safeMin = Number.isFinite(min) ? min : MIN_SESSIONS_HEIGHT
  const safeMax = Number.isFinite(max) ? Math.max(safeMin, max) : Math.max(safeMin, MAX_SESSIONS_HEIGHT)

  if (!Number.isFinite(height)) {
    return Math.min(safeMax, Math.max(safeMin, DEFAULT_SESSIONS_HEIGHT))
  }

  return Math.min(safeMax, Math.max(safeMin, height))
}

export function calculateHeightResize(
  startY: number,
  currentY: number,
  startHeight: number,
  min = MIN_SESSIONS_HEIGHT,
  max = MAX_SESSIONS_HEIGHT,
): number {
  const delta = currentY - startY
  return clampSessionsHeight(startHeight + delta, min, max)
}

export function parseSessionsHeight(
  raw: string | null | undefined,
  fallback = DEFAULT_SESSIONS_HEIGHT,
  min = MIN_SESSIONS_HEIGHT,
  max = MAX_SESSIONS_HEIGHT,
): number {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return clampSessionsHeight(fallback, min, max)
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    return clampSessionsHeight(fallback, min, max)
  }

  return clampSessionsHeight(parsed, min, max)
}
