/**
 * ADE's end of the channel to the world.
 *
 * The panel gives it the port and the things ADE can do; it decides what goes
 * over the port (the first picture when the world says `ready`, then only the
 * events, or the whole picture again when a name changed) and what comes back
 * (a command the world asks for, checked against the allowlist and against what
 * the world was actually shown). Kept apart from the panel so all of it can be
 * driven from a test with a fake port.
 */

import {
  decide,
  parseCommand,
  readFromWorld,
  vet,
  type Command,
  type Snapshot,
  type ToWorld,
} from "./protocol"
import type { PlayerSpot } from "./player"
import { diffSnapshots, needsResync } from "./snapshot"

/** The part of a `MessagePort` the link uses. */
export interface LinkPort {
  postMessage(message: ToWorld): void
  close(): void
}

/** How long the document behind the port has to answer a probe before the port is closed. */
export const PROBE_MS = 1500

export interface LinkDeps {
  port: LinkPort
  /** The picture of ADE now. */
  picture: () => Snapshot | undefined
  /** ADE does what a command asks; only ever called for one that passed every check. */
  run: (command: Command) => void
  /** A command that changes something: ADE asks the user in its own DOM, and calls `approve` on a yes. */
  ask: (command: Command, approve: () => void) => void
  /** A message the world sent that was ignored, and why. */
  ignored: (reason: string) => void
  /** Runs `run` after `ms`; the returned function cancels it. */
  schedule: (run: () => void, ms: number) => () => void
  /** The probe went unanswered and the link closed itself: the document that owned the port is gone. */
  onDead?: () => void
  /** Where the character stood last, if ADE has it: given to the world when it says `ready`. */
  player?: () => PlayerSpot | undefined
  /** The world says where the character is; ADE keeps it. */
  savePlayer?: (spot: PlayerSpot) => void
  /** The world is on screen (`opening.ts` stops waiting for it). */
  opened?: () => void
  /** The world was too slow at its level: ADE remembers it and opens it at Bassa. */
  slow?: () => void
}

export function createLink(deps: LinkDeps) {
  /** What the world has been shown; commands may only be about this. Absent until it says `ready`. */
  let shown: Snapshot | undefined
  /** The world has said `ready`: it is loaded and listening. */
  let ready = false
  let paused = false
  let closed = false
  let probes = 0
  /** The probe still waiting for its answer, and the clock that will close the link if none comes. */
  let asked: { id: number; cancel: () => void } | undefined

  const sendPicture = () => {
    const picture = deps.picture()
    if (!picture) return
    shown = picture
    deps.port.postMessage({ type: "snapshot", snapshot: picture })
  }

  return {
    /** A message arrived on the port. */
    receive(data: unknown) {
      if (closed) return
      const message = readFromWorld(data)
      if (!message) return deps.ignored("messaggio non riconosciuto")
      if (message.type === "pong") {
        // Only the answer to the probe that is waiting counts: an old or invented id is nothing.
        if (asked?.id === message.id) {
          asked.cancel()
          asked = undefined
        }
        return
      }
      if (message.type === "position") {
        deps.savePlayer?.({ x: message.x, z: message.z, heading: message.heading })
        return
      }
      if (message.type === "opened") return deps.opened?.()
      if (message.type === "slow") return deps.slow?.()
      if (message.type === "ready") {
        ready = true
        const spot = deps.player?.()
        if (spot) deps.port.postMessage({ type: "player", ...spot })
        return paused ? undefined : sendPicture()
      }
      const parsed = parseCommand(message.command)
      if (!parsed.ok) return deps.ignored(parsed.reason)
      const vetted = vet(parsed.command, shown)
      if (!vetted.ok) return deps.ignored(vetted.reason)
      if (decide(parsed.command) === "run") deps.run(parsed.command)
      else deps.ask(parsed.command, () => deps.run(parsed.command))
    },

    /** ADE changed: the world hears what is new. Nothing while it is paused (`resume` sends everything). */
    push() {
      if (closed || paused || !shown) return
      const picture = deps.picture()
      if (!picture) return
      if (needsResync(shown, picture)) return sendPicture()
      const events = diffSnapshots(shown, picture)
      shown = picture
      for (const event of events) deps.port.postMessage({ type: "event", event })
    },

    /**
     * Asks the document at the other end of the port whether it is still there.
     * A frame that navigated somewhere else took its document, and the port
     * with it, so nothing answers and the link closes; the world that reloaded
     * or came back is met again by its own `hello`, and gets a new port.
     */
    probe() {
      if (closed) return
      asked?.cancel()
      const id = ++probes
      deps.port.postMessage({ type: "ping", id })
      const cancel = deps.schedule(() => {
        if (asked?.id !== id) return
        asked = undefined
        this.close()
        deps.onDead?.()
      }, PROBE_MS)
      asked = { id, cancel }
    },

    pause() {
      if (closed || paused) return
      paused = true
      deps.port.postMessage({ type: "pause" })
    },

    /** The world draws again, and starts from the picture as it is now, not from where it stopped. */
    resume() {
      if (closed || !paused) return
      paused = false
      deps.port.postMessage({ type: "resume" })
      if (ready) sendPicture()
    },

    close() {
      closed = true
      asked?.cancel()
      asked = undefined
      shown = undefined
      deps.port.close()
    },

    /** What the world has been shown, for a test. */
    shown: () => shown,
  }
}
