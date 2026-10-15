/**
 * The Ragu Code pixel pot, as runs of pixels: the product's mark wherever the
 * voice draws one — inside the microphone capsule (`ragu-mic.tsx`) and as the
 * orb's pupil (`orb-mark.tsx`). One table, so the two cannot drift.
 *
 * From POT_16 / icon-16. Each run is [x, y, width], one pixel high.
 */
export const POT_RUNS: readonly [number, number, number][] = [
  // Steam
  [9, 0, 1],
  [6, 1, 1],
  [10, 1, 1],
  [7, 2, 1],
  [9, 2, 1],
  [6, 3, 1],
  [9, 3, 2],
  // Lid & handles
  [5, 4, 7],
  [2, 5, 12],
  // Body
  [1, 6, 14],
  [1, 7, 14],
  [0, 8, 16],
  [1, 9, 14],
  [2, 10, 12],
  [2, 11, 12],
  [2, 12, 12],
  // Base
  [3, 13, 10],
  [4, 14, 8],
]

/** The box the runs fill: the viewBox to draw them in. */
export const POT_BOX = { width: 16, height: 15 } as const
