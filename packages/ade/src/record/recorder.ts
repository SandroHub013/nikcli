/**
 * The browser side of a take: what ADE knows and the capture does not.
 *
 * The platform writes the pixels; this writes everything a promo cut needs
 * afterwards — where the pointer went, what was clicked, which pane had focus,
 * which command ran, what the assistant said — next to the video as JSON
 * lines. Nothing is drawn onto the frames: zoom and click highlights are a
 * decision taken at export, when the cut is known, and a take can be re-cut
 * without filming it again.
 *
 * Kept out of `workbench.tsx` because it is the part with rules: one take at a
 * time, the events file written even when the capture fails to close, and the
 * listeners removed whatever happens.
 */

import {
  bitrateFor,
  createEventLog,
  qualityLevel,
  recordingName,
  startProblem,
  type QualityLevel,
  type RecordEvent,
  type RecordState,
  type RecordTarget,
} from "./recording"

export interface RecorderDeps {
  /** The platform capture: `host.recordStart` and friends. */
  start: (
    target: RecordTarget,
    dir: string,
    name: string,
    quality: { fps: number; width?: number; height?: number; bitrate: number },
  ) => Promise<{ path: string | null }>
  stop: () => Promise<{ path: string | null }>
  /** Writes the events file beside the video. */
  writeText: (path: string, text: string) => Promise<void>
  /** The folder the user chose; undefined asks the caller to pick one. */
  dir: () => string | undefined
  /** The level chosen in the panel; the heaviest when absent. */
  quality?: () => QualityLevel
  now: () => number
  onState: (state: RecordState) => void
}

export interface Recorder {
  start(target: RecordTarget): Promise<string | undefined>
  stop(): Promise<string | undefined>
  /** Notes something worth keeping: ignored when nothing is being recorded. */
  note(event: RecordEvent): void
  state(): RecordState
}

/** The events file sits beside the video, same name. */
export function eventsPathFor(video: string): string {
  return `${video.replace(/\.mp4$/i, "")}.events.jsonl`
}

export function createRecorder(deps: RecorderDeps): Recorder {
  let state: RecordState = { status: "idle" }
  let log: ReturnType<typeof createEventLog> | undefined

  const settle = (next: RecordState) => {
    state = next
    deps.onState(state)
  }

  return {
    async start(target) {
      const problem = startProblem(state)
      if (problem) return problem
      const dir = deps.dir()
      if (!dir) return "Scegli prima la cartella dove salvare i video."

      const startedAt = deps.now()
      const name = recordingName(startedAt)
      try {
        const level = deps.quality?.() ?? qualityLevel(undefined)
        const started = await deps.start(target, dir, name, {
          fps: level.fps,
          bitrate: bitrateFor(level),
          ...(level.width ? { width: level.width } : {}),
          ...(level.height ? { height: level.height } : {}),
        })
        log = createEventLog(startedAt)
        settle({
          status: "recording",
          recording: { target, path: started.path ?? `${dir}/${name}.mp4`, startedAt },
        })
        return undefined
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },

    async stop() {
      if (state.status !== "recording") return undefined
      const { recording } = state
      const events = log?.text() ?? ""
      log = undefined
      settle({ status: "stopping", recording })
      try {
        const stopped = await deps.stop()
        const video = stopped.path ?? recording.path
        /*
         * Written after the capture closed its own file, and only when there
         * is something to write: an empty events file beside a video would
         * read as "nothing happened" rather than "nothing was noted".
         */
        if (events) await deps.writeText(eventsPathFor(video), events)
        settle({ status: "idle" })
        return undefined
      } catch (error) {
        // The video may still be on disk: the events go next to it anyway.
        if (events) await deps.writeText(eventsPathFor(recording.path), events).catch(() => {})
        settle({ status: "idle" })
        return error instanceof Error ? error.message : String(error)
      }
    },

    note(event) {
      if (state.status !== "recording") return
      log?.add(event)
    },

    state() {
      return state
    },
  }
}
