/**
 * Turning a take into a promo clip (S36): zoom, click rings, pointer, audio.
 *
 * Rendered by the webview itself, frame by frame, from the three files the
 * take left behind — no ffmpeg in the setup, no licence to track. The video
 * plays into a canvas through the camera `zoom.ts` planned, the pointer and
 * the click rings are drawn on top, the voice and microphone tracks are mixed
 * in, and `MediaRecorder` writes the result. It runs in real time: a minute of
 * take is a minute of export, which is the honest cost of doing it in-app.
 *
 * The original files are never touched: the clip is a new file beside them.
 */

import { mediaUrl } from "../video/video"
import { parseEventLine, type RecordEvent } from "./recording"
import { writeWav } from "./wav"
import { cameraAt, mappingFor, planShots, pointerAt, ringsAt } from "./zoom"
import { t } from "../i18n"

export interface ExportInput {
  readonly video: string
  readonly eventsText: string
  /** Absent tracks are simply not mixed in. */
  readonly voice?: string
  readonly mic?: string
  readonly fps?: number
  readonly bitrate?: number
  readonly signal?: AbortSignal
  readonly onProgress?: (fraction: number) => void
}

export interface ExportResult {
  readonly bytes: Uint8Array
  readonly extension: "mp4" | "webm"
}

/** MP4 when the webview can write it (Chromium 126+), WebM otherwise. */
export function pickExportMime(isSupported: (type: string) => boolean): {
  mimeType: string
  extension: "mp4" | "webm"
} {
  const candidates = [
    { mimeType: "video/mp4;codecs=avc1.640028,mp4a.40.2", extension: "mp4" as const },
    { mimeType: "video/mp4", extension: "mp4" as const },
    { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" as const },
  ]
  return (
    candidates.find((candidate) => isSupported(candidate.mimeType)) ?? { mimeType: "video/webm", extension: "webm" }
  )
}

/** Mono noise of one sample step (-90 dBFS), 8 kHz, as long as the take plus a second. */
export function quietWav(seconds: number, random: () => number = Math.random): ArrayBuffer {
  const sampleRate = 8000
  const length = Math.ceil(((Number.isFinite(seconds) ? seconds : 0) + 1) * sampleRate)
  const samples = new Int16Array(length)
  for (let i = 0; i < length; i++) samples[i] = random() < 0.5 ? -1 : 1
  return writeWav({ sampleRate, channels: 1, samples })
}

export function readEvents(text: string): RecordEvent[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseEventLine)
    .filter((event): event is RecordEvent => event !== undefined)
}

const loaded = (element: HTMLMediaElement) =>
  new Promise<void>((resolve, reject) => {
    if (element.readyState >= 1) return resolve()
    element.addEventListener("loadedmetadata", () => resolve(), { once: true })
    element.addEventListener("error", () => reject(new Error(t("record.export.cantOpen", element.src))), { once: true })
  })

/**
 * A list of things to undo, run once, last added first, whatever happens in between.
 *
 * The export opens an `AudioContext`, a `MediaRecorder`, the canvas's tracks, a frame loop and an object URL one
 * after the other; a failure in the middle used to leave whichever were already open (full review 2026-10-06,
 * M2). Each is registered as it is opened, and the one `finally` runs them all. A step that throws does not
 * stop the others.
 */
export function createCleanup() {
  const steps: (() => unknown)[] = []
  let ran: Promise<void> | undefined
  return {
    add(step: () => unknown) {
      steps.push(step)
    },
    /** Runs every step once; a second call waits for the first. */
    run(): Promise<void> {
      ran ??= (async () => {
        for (const step of steps.reverse()) {
          try {
            await step()
          } catch {
            // One resource that will not close must not keep the rest open.
          }
        }
      })()
      return ran
    },
  }
}

/**
 * When the microphone's own recording begins, in take time (ms).
 *
 * Its recorder starts after the capture does (the capture takes from hundreds of milliseconds to a second
 * to come up), so its file begins later than the video; the take notes the moment as a `mic` event. A take
 * from before that event has none, and plays the track from 0 as it always did.
 */
export function micOffsetMs(events: readonly RecordEvent[]): number {
  const event = events.find((candidate) => candidate.kind === "mic")
  return event && Number.isFinite(event.at) && event.at > 0 ? event.at : 0
}

/** A track that has to begin later than the video, when the video's clock says `startMs`. */
export interface LatePlayer {
  readonly startMs: number
  readonly play: () => void
}

/** Starts the players whose moment has come; the ones still waiting are returned. */
export function startDue(waiting: readonly LatePlayer[], nowMs: number): LatePlayer[] {
  const later: LatePlayer[] = []
  for (const player of waiting) {
    if (nowMs >= player.startMs) player.play()
    else later.push(player)
  }
  return later
}

export async function exportPromo(input: ExportInput): Promise<ExportResult> {
  const cleanup = createCleanup()
  try {
    return await render(input, cleanup)
  } finally {
    await cleanup.run()
  }
}

async function render(input: ExportInput, cleanup: ReturnType<typeof createCleanup>): Promise<ExportResult> {
  const events = readEvents(input.eventsText)
  const video = document.createElement("video")
  cleanup.add(() => video.removeAttribute("src"))
  // Without CORS the canvas turns unclean and MediaRecorder writes 0 bytes.
  video.crossOrigin = "anonymous"
  video.src = mediaUrl(input.video)
  video.muted = true
  video.playsInline = true
  await loaded(video)

  const width = video.videoWidth
  const height = video.videoHeight
  const durationMs = video.duration * 1000
  const mapping = mappingFor(events, width, height)
  const shots = planShots(events, mapping, durationMs)

  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext("2d")
  if (!context) throw new Error(t("record.export.noCanvas"))

  // The two audio tracks, mixed only here, into the clip.
  const audio = new AudioContext()
  cleanup.add(() => audio.close())
  const mix = audio.createMediaStreamDestination()
  const players: HTMLAudioElement[] = []
  cleanup.add(() => {
    for (const player of players) player.pause()
  })
  // The microphone's file begins when its recorder did, not with the video: it is started by the video's clock.
  let late: LatePlayer[] = []
  const lateTracks = new Set<HTMLAudioElement>()
  const micOffset = micOffsetMs(events)
  /*
   * A take with neither track still plays one element: a bed of noise too
   * quiet to hear. Without a playing element, WebView2's recorder never
   * starts its audio encoder and writes an MP4 with only the last second
   * and a half of the take (a WebM with nothing); synthetic Web Audio nodes
   * and a file of pure zeros do not count.
   */
  const bed =
    input.voice || input.mic
      ? undefined
      : URL.createObjectURL(new Blob([quietWav(video.duration)], { type: "audio/wav" }))
  if (bed) cleanup.add(() => URL.revokeObjectURL(bed))
  for (const path of [input.voice, input.mic, bed]) {
    if (!path) continue
    const player = new Audio(path === bed ? path : mediaUrl(path))
    if (path !== bed) player.crossOrigin = "anonymous"
    try {
      await loaded(player)
      audio.createMediaElementSource(player).connect(mix)
      players.push(player)
      if (path === input.mic && micOffset > 0) {
        late.push({ startMs: micOffset, play: () => void player.play().catch(() => undefined) })
        lateTracks.add(player)
      }
    } catch {
      // A track that does not open leaves the clip without it, not without a clip.
    }
  }

  const stream = canvas.captureStream(input.fps ?? 60)
  cleanup.add(() => {
    for (const track of stream.getTracks()) track.stop()
  })
  for (const track of mix.stream.getAudioTracks()) stream.addTrack(track)
  const mime = pickExportMime((type) => MediaRecorder.isTypeSupported(type))
  const recorder = new MediaRecorder(stream, {
    mimeType: mime.mimeType,
    videoBitsPerSecond: input.bitrate ?? 8_000_000,
    audioBitsPerSecond: 160_000,
  })
  const chunks: Blob[] = []
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  })
  // Stopped and waited for once, on the way out or when something fails first.
  let stopping: Promise<void> | undefined
  const stopRecording = () => {
    stopping ??= (async () => {
      if (recorder.state === "inactive") return
      const stopped = new Promise<void>((resolve) => recorder.addEventListener("stop", () => resolve(), { once: true }))
      recorder.stop()
      await stopped
    })()
    return stopping
  }
  cleanup.add(stopRecording)

  const draw = () => {
    const t = video.currentTime * 1000
    late = startDue(late, t)
    const camera = cameraAt(shots, t, width, height)
    context.drawImage(video, camera.left, camera.top, width / camera.scale, height / camera.scale, 0, 0, width, height)
    const place = (point: { x: number; y: number }) => ({
      x: (point.x - camera.left) * camera.scale,
      y: (point.y - camera.top) * camera.scale,
    })
    const unit = Math.max(width, height) / 1000

    for (const ring of ringsAt(events, mapping, t)) {
      const at = place(ring)
      context.beginPath()
      context.arc(at.x, at.y, (14 + 36 * ring.progress) * unit * camera.scale, 0, Math.PI * 2)
      context.strokeStyle = `rgba(255, 196, 0, ${1 - ring.progress})`
      context.lineWidth = 4 * unit
      context.stroke()
    }

    const pointer = pointerAt(events, mapping, t)
    if (pointer) {
      const at = place(pointer)
      context.beginPath()
      context.arc(at.x, at.y, 7 * unit * camera.scale, 0, Math.PI * 2)
      context.fillStyle = "rgba(255, 255, 255, 0.95)"
      context.fill()
      context.lineWidth = 2 * unit
      context.strokeStyle = "rgba(0, 0, 0, 0.7)"
      context.stroke()
    }
    input.onProgress?.(Math.min(1, t / durationMs))
  }

  // Cleared when the export ends or fails, so the frame loop never outlives it.
  let running = true
  cleanup.add(() => {
    running = false
  })
  const done = new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (!running) return
      if (input.signal?.aborted) return reject(new Error("Esportazione annullata."))
      draw()
      if (!video.ended) requestAnimationFrame(tick)
    }
    video.addEventListener(
      "ended",
      () => {
        draw()
        resolve()
      },
      { once: true },
    )
    video.addEventListener("error", () => reject(new Error(t("record.export.interrupted"))), {
      once: true,
    })
    requestAnimationFrame(tick)
  })
  // If something before `await done` throws, `done` may still reject later: nobody is left to hear it.
  done.catch(() => undefined)

  recorder.start(1000)
  await audio.resume()
  await Promise.all([
    video.play(),
    ...players.map((player) => (lateTracks.has(player) ? undefined : player.play().catch(() => undefined))),
  ])
  await done
  // The recorder is stopped and has written its last chunk before the clip is put together.
  await stopRecording()

  const blob = new Blob(chunks, { type: mime.mimeType })
  return { bytes: new Uint8Array(await blob.arrayBuffer()), extension: mime.extension }
}
