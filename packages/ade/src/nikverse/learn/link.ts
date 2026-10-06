/**
 * ADE's end of the lesson page's channel.
 *
 * The page runs in a frame with an opaque origin, so it can be asked for nothing and write nothing: the line between it and ADE is one
 * `MessageChannel` port, offered once after it proved with the nonce that it is that page (`handshake.ts`). What travels on it is the
 * whole of what it is allowed to say, and there is very little:
 *
 * - **ADE → page:** `progress`, once, when the page says it is there.
 * - **page → ADE:** `ready`, and `learn-save` with the progress after an answer.
 *
 * Anything else is ignored, and the reason is given to the panel so it lands in the console. That is the whole allowlist: no command
 * towards a session, nothing about a project, nothing of the workbench.
 */

import { parseProgress } from "./progress"

/** ADE → page. */
export type ToPage = { type: "progress"; progress: unknown }

/** page → ADE, once read defensively: anything that is not one of these two shapes is nothing. */
export type FromPage = { type: "ready" } | { type: "learn-save"; progress: unknown }

/** A message the page sent, if it is one ADE knows and it is well formed. */
export function readFromPage(data: unknown): FromPage | undefined {
  if (!data || typeof data !== "object") return undefined
  const body = data as { type?: unknown; progress?: unknown }
  if (body.type === "ready") return { type: "ready" }
  if (body.type === "learn-save") return { type: "learn-save", progress: body.progress }
  return undefined
}

/** The shape of what went wrong, in one line, for the console: nothing is shown to the user for a message from the frame. */
export function ignoredReason(data: unknown, extra?: string): string {
  const tipo = data && typeof data === "object" ? String((data as { type?: unknown }).type).slice(0, 40) : "non è un oggetto"
  return extra ? `${tipo}: ${extra}` : `messaggio non previsto: ${tipo}`
}

export interface LearnLink {
  /** The page is there: it is given the progress, read now so the panel opens on what is on disk. */
  onReady: () => void
  /** A message arrived on the port. */
  receive: (data: unknown) => void
  /** The port is gone with the frame: nothing said by the old document may speak for a new one. */
  close: () => void
  /** Resolves when every write this link started has finished, so something else may write the file after it. */
  settled: () => Promise<void>
}

export function createLearnLink(deps: {
  port: MessagePort
  /** The progress as it is on disk: `null` for a learner with no file yet. Rejected, nothing is written until the panel is opened again. */
  load: () => Promise<unknown>
  /** Writes a progress the page sent, after its shape has been checked. */
  save: (json: string) => Promise<void>
  /** Something the page said that ADE is not doing, and why. */
  ignored: (reason: string) => void
  /** The file on disk could not be read as a progress, so it is left alone: the user is told, the console gets the reason. */
  unreadable?: () => void
}): LearnLink {
  let closed = false
  let given = false
  /*
   * Whether the page may write: decided once, by the read. Only a first day (no file) or a progress ADE understands lets it. A read that
   * failed or a document of another version leaves the file as it is, because the page would be saving over something it never saw.
   */
  let resolveWritable: (writable: boolean) => void = () => {}
  const writable = new Promise<boolean>((resolve) => {
    resolveWritable = resolve
  })
  /** The writes, one after the other and in the order they were said: two in flight at once can finish backwards. */
  let chain: Promise<void> = Promise.resolve()
  const send = (message: ToPage) => {
    if (closed) return
    try {
      deps.port.postMessage(message)
    } catch (error) {
      deps.ignored(`non riesco a mandare il progresso: ${String((error as Error)?.message ?? error)}`)
    }
  }
  const refuse = (reason: string) => {
    resolveWritable(false)
    deps.ignored(reason)
    deps.unreadable?.()
  }
  return {
    onReady() {
      // Once: a `ready` replayed on a port that is already open must not read the file again.
      if (given || closed) return
      given = true
      void deps
        .load()
        .then((raw) => {
          if (raw === null || raw === undefined) {
            resolveWritable(true)
            send({ type: "progress", progress: null })
            return
          }
          const parsed = parseProgress(raw)
          if (!parsed.ok) return refuse(`non scrivo sopra i progressi: ${parsed.reason}`)
          resolveWritable(true)
          send({ type: "progress", progress: parsed.progress })
        })
        .catch((error) => refuse(`non riesco a leggere i progressi, non scrivo sopra: ${String(error?.message ?? error)}`))
    },
    receive(data) {
      const message = readFromPage(data)
      if (!message) {
        deps.ignored(ignoredReason(data))
        return
      }
      if (message.type === "ready") {
        this.onReady()
        return
      }
      const parsed = parseProgress(message.progress)
      if (!parsed.ok) {
        deps.ignored(ignoredReason(data, parsed.reason))
        return
      }
      const json = JSON.stringify(parsed.progress)
      chain = chain.then(async () => {
        // A save said before the read finished waits for it; one that cannot be written is dropped with its reason.
        if (!(await writable)) return deps.ignored("progresso non scritto: il file su disco non si è potuto leggere")
        if (closed) return
        try {
          await deps.save(json)
        } catch (error) {
          deps.ignored(`non riesco a scrivere i progressi: ${String((error as Error)?.message ?? error)}`)
        }
      })
    },
    close() {
      closed = true
      // A save waiting for a read that has not finished must not hold `settled` for ever: a closed link writes nothing more.
      resolveWritable(false)
      try {
        deps.port.close()
      } catch {
        // A port of a document that is already gone has nothing to close.
      }
    },
    settled: () => chain,
  }
}
