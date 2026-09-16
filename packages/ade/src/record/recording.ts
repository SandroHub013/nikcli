/**
 * Recording a video of ADE in use (S36).
 *
 * The video is captured by the operating system — Windows.Graphics.Capture,
 * ScreenCaptureKit, PipeWire — and is only ever what the window showed. What
 * makes it a usable promo video is the second half, here: while the capture
 * runs, ADE writes down where the pointer was, when it was clicked, which pane
 * had focus and which command ran. Zoom and click highlights are drawn from
 * that afterwards, at export, so nothing is burned into the frames and a take
 * can be re-cut without recording it again.
 *
 * The decisions are pure and tested here; the platform side owns only the
 * pixels.
 */

/** What the capture covers. A pane is a rectangle inside the same window. */
export type RecordTarget = { readonly kind: "window" } | { readonly kind: "pane"; readonly paneId: string }

export type RecordEvent =
  /** Where the pointer was, in window coordinates. */
  | { readonly kind: "pointer"; readonly at: number; readonly x: number; readonly y: number }
  | { readonly kind: "click"; readonly at: number; readonly x: number; readonly y: number; readonly button: "left" | "right" | "middle" }
  /** The pane that took focus: the export zooms to it. */
  | { readonly kind: "pane"; readonly at: number; readonly paneId: string }
  /** A command the user ran, by id, so the export can caption it. */
  | { readonly kind: "command"; readonly at: number; readonly id: string }
  /** Said by the assistant, for subtitles on the voice track. */
  | { readonly kind: "said"; readonly at: number; readonly text: string }

export interface Recording {
  readonly target: RecordTarget
  /** Where the video and its events are written, without extension. */
  readonly path: string
  readonly startedAt: number
}

/** What the platform side answers: it knows the file, not why a take was made. */
export interface RecordingState {
  readonly recording: boolean
  readonly path: string | null
}

export type RecordState =
  | { readonly status: "idle" }
  | { readonly status: "recording"; readonly recording: Recording }
  /** The capture is closing its file: a new one cannot start yet. */
  | { readonly status: "stopping"; readonly recording: Recording }

/**
 * Pointer positions are worth keeping at about the frame rate, no more.
 *
 * A mouse reports far more often than 60 Hz, and every extra sample is a line
 * in the events file that the export averages away anyway.
 */
export const POINTER_MIN_GAP_MS = 16

/** Clicks and pane changes are never dropped; only pointer moves are thinned. */
export function keepEvent(previous: RecordEvent | undefined, next: RecordEvent): boolean {
  if (next.kind !== "pointer") return true
  if (!previous || previous.kind !== "pointer") return true
  if (next.at - previous.at >= POINTER_MIN_GAP_MS) return true
  return false
}

/**
 * The file's base name: the date, so takes of the same session sort in order.
 *
 * Local time, because it is named after the moment the user recorded it, not
 * after UTC.
 */
export function recordingName(at: number): string {
  const d = new Date(at)
  const two = (n: number) => String(n).padStart(2, "0")
  return `ADE ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}`
}

/** One event per line, so a long take streams to disk instead of being held. */
export function eventLine(event: RecordEvent, startedAt: number): string {
  return JSON.stringify({ ...event, at: Math.max(0, Math.round(event.at - startedAt)) })
}

export function parseEventLine(line: string): RecordEvent | undefined {
  try {
    const parsed = JSON.parse(line) as RecordEvent
    return typeof parsed?.kind === "string" && typeof parsed?.at === "number" ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Collects what happens during a take, thinning the pointer as it goes. */
export function createEventLog(startedAt: number) {
  const lines: string[] = []
  let last: RecordEvent | undefined
  return {
    add(event: RecordEvent): boolean {
      if (!keepEvent(last, event)) return false
      last = event
      lines.push(eventLine(event, startedAt))
      return true
    },
    /** What is written next to the video, as JSON lines. */
    text(): string {
      return lines.length > 0 ? `${lines.join("\n")}\n` : ""
    },
    get length(): number {
      return lines.length
    },
  }
}

/** What the user is told when a take cannot start. */
export function startProblem(state: RecordState): string | undefined {
  if (state.status === "recording") return "Una registrazione è già in corso."
  if (state.status === "stopping") return "La registrazione precedente sta chiudendo il file: riprova tra un istante."
  return undefined
}
