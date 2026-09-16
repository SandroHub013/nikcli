import { describe, expect, test } from "bun:test"
import { createRecorder, eventsPathFor } from "./recorder"
import type { RecordState, RecordTarget } from "./recording"

const T0 = new Date(2026, 8, 16, 9, 5, 3).getTime()

function setup(overrides: { start?: () => Promise<{ path: string | null }>; stop?: () => Promise<{ path: string | null }>; dir?: () => string | undefined } = {}) {
  const started: { target: RecordTarget; dir: string; name: string }[] = []
  const written: { path: string; text: string }[] = []
  const states: RecordState[] = []
  let now = T0
  const recorder = createRecorder({
    start: overrides.start
      ? (target, dir, name) => {
          started.push({ target, dir, name })
          return overrides.start!()
        }
      : async (target, dir, name) => {
          started.push({ target, dir, name })
          return { path: `${dir}/${name}.mp4` }
        },
    stop: overrides.stop ?? (async () => ({ path: "C:/video/ADE 2026-09-16 09.05.03.mp4" })),
    writeText: async (path, text) => {
      written.push({ path, text })
    },
    dir: overrides.dir ?? (() => "C:/video"),
    now: () => now,
    onState: (state) => states.push(state),
  })
  return { recorder, started, written, states, advance: (ms: number) => (now += ms) }
}

describe("record/recorder", () => {
  test("a take writes the events beside the video, and only what was noted", async () => {
    const { recorder, started, written, advance } = setup()

    expect(await recorder.start({ kind: "window" })).toBeUndefined()
    expect(started[0]).toEqual({ target: { kind: "window" }, dir: "C:/video", name: "ADE 2026-09-16 09.05.03" })

    advance(500)
    recorder.note({ kind: "click", at: T0 + 500, x: 12, y: 34, button: "left" })
    recorder.note({ kind: "command", at: T0 + 700, id: "session.new" })
    expect(await recorder.stop()).toBeUndefined()

    expect(written).toHaveLength(1)
    expect(written[0]!.path).toBe("C:/video/ADE 2026-09-16 09.05.03.events.jsonl")
    expect(written[0]!.text.trimEnd().split("\n")).toHaveLength(2)
    expect(recorder.state()).toEqual({ status: "idle" })
  })

  test("nothing noted, no events file: an empty one would read as an empty take", async () => {
    const { recorder, written } = setup()
    await recorder.start({ kind: "window" })
    await recorder.stop()
    expect(written).toEqual([])
  })

  test("a second take is refused while one runs, and notes outside a take are dropped", async () => {
    const { recorder, started, written } = setup()
    await recorder.start({ kind: "window" })
    expect(await recorder.start({ kind: "window" })).toContain("già in corso")
    expect(started).toHaveLength(1)

    await recorder.stop()
    recorder.note({ kind: "click", at: T0 + 10, x: 1, y: 1, button: "left" })
    await recorder.stop()
    expect(written).toEqual([])
  })

  test("without a folder nothing is started, and the user is told which one to pick", async () => {
    const { recorder, started } = setup({ dir: () => undefined })
    expect(await recorder.start({ kind: "window" })).toContain("cartella")
    expect(started).toEqual([])
    expect(recorder.state()).toEqual({ status: "idle" })
  })

  test("a capture that fails to start leaves ADE idle, with the reason", async () => {
    const { recorder, states } = setup({ start: async () => Promise.reject(new Error("Windows 10 1809 non basta")) })
    expect(await recorder.start({ kind: "window" })).toBe("Windows 10 1809 non basta")
    expect(recorder.state()).toEqual({ status: "idle" })
    expect(states).toEqual([])
  })

  test("a capture that fails to close still saves the events, next to where the video was going", async () => {
    const { recorder, written } = setup({ stop: async () => Promise.reject(new Error("file non chiuso")) })
    await recorder.start({ kind: "window" })
    recorder.note({ kind: "said", at: T0 + 10, text: "Fatto." })
    expect(await recorder.stop()).toBe("file non chiuso")
    expect(written[0]!.path).toBe("C:/video/ADE 2026-09-16 09.05.03.events.jsonl")
    expect(recorder.state()).toEqual({ status: "idle" })
  })

  test("the events file is the video's name, whatever the video is called", () => {
    expect(eventsPathFor("C:/video/ADE 2026.mp4")).toBe("C:/video/ADE 2026.events.jsonl")
    expect(eventsPathFor("C:/video/ADE 2026.MP4")).toBe("C:/video/ADE 2026.events.jsonl")
  })
})
