/**
 * Pure windowing math for the session message list.
 *
 * First step of `specs/effect-tui/06-terminal-rendering.md`: extract the
 * scroll→visible-range computation as a dependency-free, unit-testable module so the live
 * render can later switch from `<For each={messages()}>` to a windowed slice behind a flag
 * without re-deriving this logic. This module performs no DOM/OpenTUI work.
 */

/** Running sum of heights: `offsets[i]` is the top y of message `i`, `offsets[n]` is total height. */
export function cumulativeOffsets(heights: number[]): number[] {
  const offsets = new Array<number>(heights.length + 1)
  offsets[0] = 0
  for (let i = 0; i < heights.length; i++) {
    offsets[i + 1] = offsets[i] + Math.max(0, heights[i])
  }
  return offsets
}

/** Largest index `i` with `offsets[i] <= y` (binary search). Clamped to `[0, len-1]`. */
export function indexAtOffset(offsets: number[], y: number): number {
  const last = offsets.length - 1 // == message count
  if (last <= 0) return 0
  let lo = 0
  let hi = last - 1
  let result = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] <= y) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

export type VisibleRangeInput = {
  /** Per-message heights, in render order. */
  heights: number[]
  /** Scroll offset of the viewport top, in the same units as heights. */
  scrollTop: number
  /** Height of the visible viewport. */
  viewportHeight: number
  /** Extra messages to mount above/below the viewport to avoid mount churn on scroll. */
  overscan?: number
}

/**
 * Compute the half-open `[start, end)` slice of messages that intersect the viewport,
 * padded by `overscan`. `end` is exclusive and suitable for `messages.slice(start, end)`.
 */
export function visibleRange(input: VisibleRangeInput): { start: number; end: number } {
  const { heights, scrollTop, viewportHeight } = input
  const overscan = Math.max(0, input.overscan ?? 0)
  const count = heights.length
  if (count === 0) return { start: 0, end: 0 }

  const offsets = cumulativeOffsets(heights)
  const top = Math.max(0, scrollTop)
  const bottom = scrollTop + Math.max(0, viewportHeight)
  if (bottom <= 0) return { start: 0, end: 0 }

  // The viewport bottom is exclusive, so the last visible message is the one containing the
  // last visible pixel (`bottom - 1`); a message whose top sits exactly on `bottom` is offscreen.
  const first = indexAtOffset(offsets, top)
  const last = indexAtOffset(offsets, bottom - 1)

  const start = Math.max(0, first - overscan)
  const end = Math.min(count, last + 1 + overscan)
  return { start, end }
}

/** Total spacer heights above/below the rendered window, for scrollbar/sticky math. */
export function spacerHeights(
  heights: number[],
  range: { start: number; end: number },
): { top: number; bottom: number } {
  const offsets = cumulativeOffsets(heights)
  const total = offsets[offsets.length - 1]
  const top = offsets[Math.min(range.start, heights.length)]
  const bottom = total - offsets[Math.min(range.end, heights.length)]
  return { top: Math.max(0, top), bottom: Math.max(0, bottom) }
}

/**
 * Above this many turns the transcript is windowed even when the user has not
 * set `experimental.tui.messageVirtualization`.
 *
 * Measured with every row mounted, from source on Windows: 40 messages took
 * 1376 native text buffers and 777 MB, 300 took 7878 and 1074 MB, and a
 * 1180-message session reached opentui's limit at ~16 thousand and could not
 * be drawn at all. Windowed, each of them stayed between 630 and 740 buffers.
 * At 150 a full mount is some 4 thousand buffers, a quarter of the limit;
 * below it a session keeps every row, so selection, search and jumps work on
 * real rows instead of estimated heights.
 */
export const AUTO_WINDOW_TURNS = 150

/**
 * Whether the transcript is windowed. The user's explicit setting always wins,
 * either way; unset, the size of the session decides.
 */
export function windowingOn(setting: boolean | undefined, turns: number): boolean {
  return setting ?? turns > AUTO_WINDOW_TURNS
}

export type TranscriptWindowInput = VisibleRangeInput & {
  /**
   * The scrollbox is held at the bottom, as it is when a session opens and
   * while a reply is being written.
   */
  atBottom: boolean
}

/** The turns to mount, `[start, end)`, and the spacer rows that stand in for the rest. */
export function transcriptWindow(input: TranscriptWindowInput): {
  start: number
  end: number
  top: number
  bottom: number
} {
  const { heights, atBottom } = input
  const total = cumulativeOffsets(heights)[heights.length]
  // Held at the bottom, the window is the tail, counted back from the end.
  // `scrollTop` there is the real one, laid out from real rows, and the
  // estimates can put it a few turns short of the end: the reply being
  // written was windowed out and the view jumped. That is why windowing used
  // to switch off while a turn was open, and on a large session switching it
  // off mounted every row at once, which is the failure it exists to prevent.
  const scrollTop = atBottom ? Math.max(0, total - input.viewportHeight) : input.scrollTop
  const range = visibleRange({ ...input, scrollTop })
  const end = atBottom ? heights.length : range.end
  const spacers = spacerHeights(heights, { start: range.start, end })
  return { start: range.start, end, top: spacers.top, bottom: spacers.bottom }
}
