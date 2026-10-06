import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  createCleanup,
  exportPromo,
  micOffsetMs,
  pickExportMime,
  quietWav,
  readEvents,
  startDue,
  waitAtMost,
} from "./export"

describe("record/export", () => {
  test("MP4 when the webview can write it, WebM otherwise", () => {
    expect(pickExportMime(() => true).extension).toBe("mp4")
    expect(pickExportMime((type) => type.startsWith("video/webm")).extension).toBe("webm")
    expect(pickExportMime(() => false)).toEqual({ mimeType: "video/webm", extension: "webm" })
  })

  test("the bed under a take without audio outlasts the take and is never louder than a step", () => {
    const wav = new DataView(quietWav(2, () => 0.9))
    expect(wav.byteLength).toBe(44 + 3 * 8000 * 2)
    expect(wav.getInt16(44, true)).toBe(1)
    expect(new DataView(quietWav(Number.NaN, () => 0.1)).getInt16(44, true)).toBe(-1)
  })

  test("the events file is read line by line, and a broken line is skipped", () => {
    const text = [
      '{"kind":"frame","at":0,"width":10,"height":10,"dpr":1}',
      "{rotto",
      "",
      '{"kind":"click","at":5,"x":1,"y":2,"button":"left"}',
    ].join("\n")
    expect(readEvents(text).map((event) => event.kind)).toEqual(["frame", "click"])
  })
})

/*
 * Full review 2026-10-06, M2: `video.play()` or `audio.resume()` refusing, after the recorder, the audio
 * context and the frame loop were open, left all of them open and the frame loop drawing for ever.
 */
describe("record/export, cleanup", () => {
  test("every step runs once, the last added first, and one that throws does not stop the others", async () => {
    const order: string[] = []
    const cleanup = createCleanup()
    cleanup.add(() => order.push("first"))
    cleanup.add(() => {
      throw new Error("will not close")
    })
    cleanup.add(async () => {
      await Promise.resolve()
      order.push("last")
    })
    await cleanup.run()
    await cleanup.run()
    expect(order).toEqual(["last", "first"])
  })

  test("a second run waits for the first instead of starting over", async () => {
    let calls = 0
    const cleanup = createCleanup()
    cleanup.add(async () => {
      calls++
      await Promise.resolve()
    })
    await Promise.all([cleanup.run(), cleanup.run()])
    expect(calls).toBe(1)
  })
})

describe("record/export, a playback that is refused", () => {
  type Fake = Record<string, unknown>
  const globals = globalThis as unknown as Fake
  const names = ["document", "AudioContext", "Audio", "MediaRecorder", "requestAnimationFrame"]
  const saved = new Map<string, unknown>()

  function install(failure: "video.play" | "audio.resume") {
    const log: string[] = []
    const frames: (() => void)[] = []
    let drawn = 0
    const context = {
      drawImage: () => void drawn++,
      beginPath: () => {},
      arc: () => {},
      stroke: () => {},
      fill: () => {},
    }
    const track = { stop: () => void log.push("track.stop") }
    const stream = { getTracks: () => [track], addTrack: () => {} }
    const video = {
      readyState: 4,
      videoWidth: 100,
      videoHeight: 50,
      duration: 2,
      currentTime: 0,
      ended: false,
      addEventListener: () => {},
      removeAttribute: (name: string) => void log.push(`video.removeAttribute ${name}`),
      play: () => (failure === "video.play" ? Promise.reject(new Error("autoplay refused")) : Promise.resolve()),
    }
    const canvas = { getContext: () => context, captureStream: () => stream }
    globals.document = { createElement: (tag: string) => (tag === "video" ? video : canvas) }
    globals.requestAnimationFrame = (frame: () => void) => frames.push(frame)
    globals.AudioContext = class {
      createMediaStreamDestination() {
        return { stream: { getAudioTracks: () => [] } }
      }
      createMediaElementSource() {
        return { connect: () => {} }
      }
      resume() {
        return failure === "audio.resume" ? Promise.reject(new Error("resume refused")) : Promise.resolve()
      }
      close() {
        log.push("audio.close")
        return Promise.resolve()
      }
    }
    globals.Audio = class {
      readyState = 4
      crossOrigin = ""
      addEventListener() {}
      pause() {
        log.push("player.pause")
      }
      play() {
        return Promise.resolve()
      }
    }
    globals.MediaRecorder = class {
      static isTypeSupported() {
        return true
      }
      state = "inactive"
      private stopped: (() => void) | undefined
      addEventListener(type: string, listener: () => void) {
        if (type === "stop") this.stopped = listener
      }
      start() {
        this.state = "recording"
        log.push("recorder.start")
      }
      stop() {
        this.state = "inactive"
        log.push("recorder.stop")
        queueMicrotask(() => this.stopped?.())
      }
    }
    return { log, frames, drawn: () => drawn }
  }

  beforeEach(() => {
    for (const name of names) saved.set(name, globals[name])
  })
  afterEach(() => {
    for (const name of names) {
      if (saved.get(name) === undefined) delete globals[name]
      else globals[name] = saved.get(name)
    }
  })

  for (const failure of ["video.play", "audio.resume"] as const) {
    test(`${failure} refusing closes the recorder, the audio and the tracks, and stops the frame loop`, async () => {
      const fake = install(failure)
      await expect(exportPromo({ video: "C:/take/ADE.mp4", eventsText: "" })).rejects.toThrow("refused")

      expect(fake.log).toContain("recorder.stop")
      expect(fake.log).toContain("audio.close")
      expect(fake.log).toContain("track.stop")
      expect(fake.log).toContain("player.pause")
      expect(fake.log).toContain("video.removeAttribute src")
      // The loop was scheduled before the failure; its next turn must draw nothing and ask for no more.
      const scheduled = fake.frames.length
      const drawn = fake.drawn()
      for (const frame of [...fake.frames]) frame()
      expect(fake.drawn()).toBe(drawn)
      expect(fake.frames.length).toBe(scheduled)
    })
  }
})

describe("record/export, a recorder that never stops", () => {
  test("the wait ends at the cap, and an answer that comes first ends it at once", async () => {
    const started = Date.now()
    await waitAtMost(new Promise(() => {}), 30)
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
    const quick = Date.now()
    await waitAtMost(Promise.resolve(), 5000)
    expect(Date.now() - quick).toBeLessThan(1000)
  })

  test("a rejecting wait is not hidden: the cap does not swallow what the promise says", async () => {
    await expect(waitAtMost(Promise.reject(new Error("boom")), 1000)).rejects.toThrow("boom")
  })
})

describe("record/export, the microphone's own start", () => {
  const event = (kind: string, at: number) => ({ kind, at }) as never

  test("the moment is read from the take's mic event, and is 0 for a take that has none", () => {
    expect(micOffsetMs([event("frame", 0), event("mic", 640), event("click", 900)])).toBe(640)
    expect(micOffsetMs([event("frame", 0), event("click", 900)])).toBe(0)
    expect(micOffsetMs([event("mic", 0)])).toBe(0)
    expect(micOffsetMs([event("mic", Number.NaN)])).toBe(0)
  })

  test("a late track starts when the video's clock reaches it, once, and the others keep waiting", () => {
    const started: string[] = []
    const waiting = [
      { startMs: 640, play: () => void started.push("mic") },
      { startMs: 2000, play: () => void started.push("later") },
    ]
    let left = startDue(waiting, 100)
    expect(started).toEqual([])
    expect(left.length).toBe(2)
    left = startDue(left, 640)
    expect(started).toEqual(["mic"])
    left = startDue(left, 700)
    expect(started).toEqual(["mic"])
    left = startDue(left, 2500)
    expect(started).toEqual(["mic", "later"])
    expect(left).toEqual([])
  })
})
