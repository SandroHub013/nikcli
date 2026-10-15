/**
 * When ragu may make a sound.
 *
 * The server publishes `session.idle` every time a session's status is set back to idle, and `PromptState.finish`
 * does that for every session that ran a prompt loop: the main one, each subagent's child session, and a cancel on a
 * session that was already idle. A turn with two subagents is four `session.idle`, and the pulses rotate
 * (pulse-a, -b, -c) so they sound like a tune played one after the other. `permission.asked` can come again for the
 * same request (a reconnect, a workspace mirror). The handlers in app.tsx used to ring on each of them.
 *
 * The rules, each with its test:
 * - only the session the TUI is showing, never a child: idle sounds for the displayed root session; a permission also
 *   for a subagent of it, because a block nobody hears is worse than one more sound;
 * - idle sounds once, at the end of a real turn: a session must have been busy since its last idle, and the sound waits
 *   `IDLE_SETTLE_MS` so a retry, a compaction or an auto-continue that goes busy again does not ring in between;
 * - a permission request rings once, however many times it is announced;
 * - at most one sound every `SOUND_MIN_GAP_MS` in the process.
 */
export const SOUND_MIN_GAP_MS = 3000
export const IDLE_SETTLE_MS = 1200

/** Loudness of each call, as `Sound.pulse` takes it (a permission is louder than a turn that ended). */
export const SOUND_SCALE = { permission: 1.3, idle: 0.8 } as const

export type SoundPolicyDeps = {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** The session the TUI is showing, if it is showing one. */
  displayed(): string | undefined
  /** The top of a session's parent chain (itself if it has no parent). */
  rootOf(sessionID: string): string
  /** The user is looking at ragu and said they do not want to be told. */
  muted(): boolean
  play(scale: number): void
}

const ASKED_KEPT = 200

export function createSoundPolicy(deps: SoundPolicyDeps) {
  const busy = new Set<string>()
  const settling = new Map<string, unknown>()
  const asked = new Set<string>()
  let last = Number.NEGATIVE_INFINITY

  function emit(scale: number): boolean {
    if (deps.muted()) return false
    const at = deps.now()
    if (at - last < SOUND_MIN_GAP_MS) return false
    last = at
    deps.play(scale)
    return true
  }

  function unsettle(sessionID: string) {
    const handle = settling.get(sessionID)
    if (handle === undefined) return
    deps.clearTimer(handle)
    settling.delete(sessionID)
  }

  return {
    /** `session.status`: busy and retry both mean the turn goes on. */
    status(sessionID: string, type: string) {
      if (type === "idle") return
      busy.add(sessionID)
      unsettle(sessionID)
    },

    /** `session.idle`. */
    idle(sessionID: string) {
      if (!busy.delete(sessionID)) return
      if (sessionID !== deps.displayed() || deps.rootOf(sessionID) !== sessionID) return
      unsettle(sessionID)
      settling.set(
        sessionID,
        deps.setTimer(() => {
          settling.delete(sessionID)
          if (sessionID !== deps.displayed()) return
          emit(SOUND_SCALE.idle)
        }, IDLE_SETTLE_MS),
      )
    },

    /** `permission.asked`. */
    permission(requestID: string, sessionID: string) {
      if (asked.has(requestID)) return
      const shown = deps.displayed()
      if (!shown || deps.rootOf(sessionID) !== shown) return
      if (!emit(SOUND_SCALE.permission)) return
      asked.add(requestID)
      if (asked.size > ASKED_KEPT) asked.delete(asked.values().next().value as string)
    },

    dispose() {
      for (const handle of settling.values()) deps.clearTimer(handle)
      settling.clear()
    },
  }
}

/** The top of a session's parent chain, given how to read one session's parent. A loop in the data stops the walk. */
export function rootSessionID(sessionID: string, parentOf: (id: string) => string | undefined): string {
  const seen = new Set<string>()
  let id = sessionID
  for (let parent = parentOf(id); parent && !seen.has(id); parent = parentOf(id)) {
    seen.add(id)
    id = parent
  }
  return id
}

export type SoundPolicy = ReturnType<typeof createSoundPolicy>
