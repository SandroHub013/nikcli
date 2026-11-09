/**
 * Two waits the video pane did by hand, kept apart so they can be tested without a real element (MOD-13).
 *
 * Both are about an event that may never come: a seek that fails fires `error` or nothing, and opening a file the
 * element already holds fires no `loadedmetadata` again. A command that waits for those answers nobody, so the agent
 * that asked for it hangs.
 */

/** The part of an `HTMLVideoElement` the waits read. */
export type WaitableVideo = EventTarget & { currentTime: number; readyState: number }

/** How long a seek is waited for. A frame that does not arrive in this time is answered with where the video is. */
export const SEEK_TIMEOUT_MS = 5000

/**
 * Moves the video to `seconds` and resolves with where it ended up: on `seeked`, on `error`, or when `timeoutMs` has
 * passed. Both listeners and the timer are removed whichever comes first.
 */
export function waitForSeek(video: WaitableVideo, seconds: number, timeoutMs = SEEK_TIMEOUT_MS): Promise<number> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let finished = false
    const done = () => {
      if (finished) return
      finished = true
      video.removeEventListener("seeked", done)
      video.removeEventListener("error", done)
      if (timer !== undefined) clearTimeout(timer)
      resolve(video.currentTime)
    }
    video.addEventListener("seeked", done)
    video.addEventListener("error", done)
    timer = setTimeout(done, timeoutMs)
    // Asked before the assignment: once it is made, `currentTime` reads the new value at once, seeked or not.
    const already = Math.abs(video.currentTime - seconds) < 0.001
    video.currentTime = seconds
    /*
     * A seek to where the element already is fires no `seeked` at all, and the command would never answer.
     * Resolving on the next frame in that case is not a guess: the position is already correct.
     */
    if (already) queueMicrotask(done)
  })
}

/**
 * Whether `path` is the file the element already holds, with its metadata in: opening it again would wait for a
 * `loadedmetadata` that does not come twice.
 */
export function alreadyOpen(video: Pick<WaitableVideo, "readyState"> | undefined, openPath: string | undefined, path: string): boolean {
  return video !== undefined && openPath !== undefined && openPath === path && video.readyState >= 1
}
