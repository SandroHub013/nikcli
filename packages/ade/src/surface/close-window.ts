/**
 * Closing the window for good, once the workbench has reached the disk.
 *
 * The autosave writes after a debounce of 1 s, or a ceiling of 10 s, and
 * WebView2 moves localStorage to its disk store a moment after `setItem`.
 * `runUpdate` waited for both; the X did not, and a close lost the last seconds
 * of state: conversation ids, worktrees, titles (review area 2, MEDIO).
 */
export const STORE_SETTLE_MS = 1_500

export async function closeAfterSaving(steps: {
  flush: () => void
  close: () => Promise<void>
  settle?: () => Promise<void>
}): Promise<void> {
  steps.flush()
  await (steps.settle ?? (() => new Promise<void>((resolve) => setTimeout(resolve, STORE_SETTLE_MS))))()
  await steps.close()
}
