import { describe, expect, test } from "bun:test"
import {
  createEventLog,
  eventLine,
  keepEvent,
  parseEventLine,
  POINTER_MIN_GAP_MS,
  recordingName,
  startProblem,
  type RecordEvent,
  type Recording,
} from "./recording"

const T0 = new Date(2026, 8, 16, 9, 5, 3).getTime()

const pointer = (at: number, x = 10, y = 20): RecordEvent => ({ kind: "pointer", at, x, y })

describe("record/recording", () => {
  test("pointer moves are thinned to about a frame, clicks and panes never", () => {
    expect(keepEvent(undefined, pointer(T0))).toBe(true)
    expect(keepEvent(pointer(T0), pointer(T0 + POINTER_MIN_GAP_MS))).toBe(true)
    expect(keepEvent(pointer(T0), pointer(T0 + 3))).toBe(false)
    // A click between two close moves stays, and does not hide the next move.
    expect(keepEvent(pointer(T0), { kind: "click", at: T0 + 1, x: 1, y: 2, button: "left" })).toBe(true)
    expect(keepEvent({ kind: "pane", at: T0, paneId: "p1" }, pointer(T0 + 1))).toBe(true)
  })

  test("the log keeps times relative to the take, so a cut moves with them", () => {
    const log = createEventLog(T0)
    expect(log.add(pointer(T0 + 100))).toBe(true)
    expect(log.add(pointer(T0 + 104))).toBe(false)
    expect(log.add({ kind: "click", at: T0 + 105, x: 3, y: 4, button: "left" })).toBe(true)
    expect(log.add({ kind: "command", at: T0 + 900, id: "session.new" })).toBe(true)

    expect(log.length).toBe(3)
    const lines = log.text().trimEnd().split("\n").map(parseEventLine)
    expect(lines.map((event) => event?.at)).toEqual([100, 105, 900])
    expect(lines[1]).toEqual({ kind: "click", at: 105, x: 3, y: 4, button: "left" })
    expect(log.text().endsWith("\n")).toBe(true)
  })

  test("an empty take writes no events file at all", () => {
    expect(createEventLog(T0).text()).toBe("")
  })

  test("a line that is not an event is dropped instead of breaking the export", () => {
    expect(parseEventLine("{")).toBeUndefined()
    expect(parseEventLine("null")).toBeUndefined()
    expect(parseEventLine(JSON.stringify({ kind: "pointer" }))).toBeUndefined()
    expect(parseEventLine(eventLine(pointer(T0 + 5), T0))).toEqual({ kind: "pointer", at: 5, x: 10, y: 20 })
  })

  test("a take is named after the local moment it was recorded", () => {
    expect(recordingName(T0)).toBe("ADE 2026-09-16 09.05.03")
  })

  test("only one take at a time, and the closing one is not a failure", () => {
    const recording: Recording = { target: { kind: "window" }, path: "C:/video/ADE", startedAt: T0 }
    expect(startProblem({ status: "idle" })).toBeUndefined()
    expect(startProblem({ status: "recording", recording })).toContain("già in corso")
    expect(startProblem({ status: "stopping", recording })).toContain("riprova")
  })
})
