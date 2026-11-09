/**
 * Writes something down only when it changed, and tries again when a write failed (WB-13).
 *
 * The held mail was saved when its fingerprint differed from the last one SEEN, and the fingerprint was remembered
 * before the write was attempted. A write that failed (storage full) was therefore never tried again for the same
 * content: the queue the user had waiting vanished at the next restart, and nobody was told after the first time.
 * Here the fingerprint is remembered only once a write has gone through, so the same content is written again at the
 * next change of anything, and `onFail` says so once for a run of failures, not at every attempt.
 */
export function createChangeWriter(onFail: () => void) {
  let written: string | undefined
  let failing = false

  return {
    /**
     * Writes if `fingerprint` is not what was last written successfully. `write` returns whether it went through.
     * Returns whether the content is saved (it was already, or it was written now).
     */
    save(fingerprint: string, write: () => boolean): boolean {
      if (written !== undefined && fingerprint === written) return true
      if (write()) {
        written = fingerprint
        failing = false
        return true
      }
      if (!failing) {
        failing = true
        onFail()
      }
      return false
    },
  }
}
