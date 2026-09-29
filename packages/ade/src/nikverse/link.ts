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
import { diffSnapshots, needsResync } from "./snapshot"

/** The part of a `MessagePort` the link uses. */
export interface LinkPort {
  postMessage(message: ToWorld): void
  close(): void
}

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
}

export function createLink(deps: LinkDeps) {
  /** What the world has been shown; commands may only be about this. Absent until it says `ready`. */
  let shown: Snapshot | undefined
  /** The world has said `ready`: it is loaded and listening. */
  let ready = false
  let paused = false
  let closed = false

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
      if (message.type === "ready") {
        ready = true
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
      shown = undefined
      deps.port.close()
    },

    /** What the world has been shown, for a test. */
    shown: () => shown,
  }
}
