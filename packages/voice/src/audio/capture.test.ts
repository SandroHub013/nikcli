import { describe, expect, test } from "bun:test"
import {
  chooseSupportedAudioMimeType,
  createMicCapture,
  LEVEL_EPSILON,
  LEVEL_INTERVAL_MS,
  MAX_SEGMENT_DURATION_MS,
  MIN_SEGMENT_DURATION_MS,
  resamplePcm,
  type CapturedSegment,
  type SegmentAudio,
} from "./capture"

// Fake MediaStreamTrack counting stop() invocations
class MockMediaStreamTrack {
  stopCalls = 0
  readyState = "live"

  stop(): void {
    this.stopCalls++
    this.readyState = "ended"
  }
}

// Fake MediaStream wrapping mock tracks
class MockMediaStream {
  tracks: MockMediaStreamTrack[]

  constructor(tracks: MockMediaStreamTrack[] = [new MockMediaStreamTrack(), new MockMediaStreamTrack()]) {
    this.tracks = tracks
  }

  getTracks(): MockMediaStreamTrack[] {
    return this.tracks
  }
}

// Fake MediaRecorder
class MockMediaRecorder {
  state: "inactive" | "recording" | "paused" = "inactive"
  stream: any
  mimeType: string
  ondataavailable: any = null
  onstop: any = null
  startCalls = 0
  stopCalls = 0

  constructor(stream: any, options: { mimeType?: string } = {}) {
    this.stream = stream
    this.mimeType = options.mimeType ?? "audio/webm;codecs=opus"
  }

  start(): void {
    this.startCalls++
    this.state = "recording"
  }

  stop(): void {
    this.stopCalls++
    this.state = "inactive"
    if (this.ondataavailable) {
      // Emit a fake Blob chunk
      this.ondataavailable({
        data: new Blob(["simulated-audio-data"], { type: this.mimeType }),
      })
    }
    if (this.onstop) {
      this.onstop()
    }
  }
}

describe("audio/capture", () => {
  test("format selection prefers opus/webm then falls back to mp4, or throws clear Italian error", () => {
    // 1. Both available -> chooses webm
    const pickWebm = chooseSupportedAudioMimeType((mime) => mime === "audio/webm;codecs=opus" || mime === "audio/mp4")
    expect(pickWebm).toEqual({ mimeType: "audio/webm;codecs=opus", format: "webm" })

    // 2. Only mp4 available -> chooses m4a
    const pickMp4 = chooseSupportedAudioMimeType((mime) => mime === "audio/mp4")
    expect(pickMp4).toEqual({ mimeType: "audio/mp4", format: "m4a" })

    // 3. Neither available -> throws Italian error
    expect(() => chooseSupportedAudioMimeType(() => false)).toThrow(
      /Nessun formato audio supportato per la registrazione/i,
    )
  })

  test("resamples PCM buffer to 16 kHz mono when input sample rate is different", () => {
    // A buffer of 4800 samples at 48000 Hz represents 100 ms of audio
    const samples48k = new Float32Array(4800)
    for (let i = 0; i < samples48k.length; i++) {
      samples48k[i] = Math.sin((i / 4800) * Math.PI * 2)
    }

    const resampled = resamplePcm(samples48k, 48000, 16000)
    // 4800 / (48000 / 16000) = 1600 samples at 16000 Hz
    expect(resampled.length).toBe(1600)
    expect(resampled).toBeInstanceOf(Float32Array)

    // Identity when already 16 kHz
    const samples16k = new Float32Array(160)
    expect(resamplePcm(samples16k, 16000, 16000)).toBe(samples16k)
  })

  test("discards speech segments shorter than MIN_SEGMENT_DURATION_MS (e.g. coughs)", async () => {
    let simulatedTime = 10_000
    const segments: CapturedSegment[] = []
    const track = new MockMediaStreamTrack()
    const stream = new MockMediaStream([track]) as any

    const capture = createMicCapture({
      now: () => simulatedTime,
      mediaStream: stream,
      mediaRecorderClass: MockMediaRecorder as any,
      isTypeSupported: () => true,
      onSegment: (seg) => {
        segments.push(seg)
      },
      speechDetectorConfig: {
        speechThreshold: 0.05,
        minSpeechDurationMs: 50,
        silenceDurationMs: 200,
      },
    })

    await capture.start()

    // Loud frame simulating speech start
    const loudFrame = new Float32Array(160).fill(0.5)
    capture.processAudioFrame(loudFrame)

    // Advance by 80 ms (longer than minSpeechDurationMs, confirming speech start)
    simulatedTime += 80
    capture.processAudioFrame(loudFrame)

    // Now silence begins immediately: 200 ms silence timeout fires
    const silentFrame = new Float32Array(160).fill(0.0)
    simulatedTime += 220
    capture.processAudioFrame(silentFrame)

    // Total utterance duration is ~80 ms, well below MIN_SEGMENT_DURATION_MS (500 ms)
    // Segment must be discarded!
    expect(segments).toHaveLength(0)

    capture.stop()
  })

  test("closes segment and emits blob when duration exceeds MAX_SEGMENT_DURATION_MS", async () => {
    let simulatedTime = 10_000
    const segments: CapturedSegment[] = []
    const track = new MockMediaStreamTrack()
    const stream = new MockMediaStream([track]) as any

    const capture = createMicCapture({
      now: () => simulatedTime,
      mediaStream: stream,
      mediaRecorderClass: MockMediaRecorder as any,
      isTypeSupported: () => true,
      onSegment: (seg) => {
        segments.push(seg)
      },
      speechDetectorConfig: {
        speechThreshold: 0.05,
        minSpeechDurationMs: 50,
        silenceDurationMs: 1200,
      },
    })

    await capture.start()

    const loudFrame = new Float32Array(160).fill(0.5)

    // Speech start
    capture.processAudioFrame(loudFrame)
    simulatedTime += 100
    capture.processAudioFrame(loudFrame)

    // Continuous speaking until exceeding MAX_SEGMENT_DURATION_MS
    simulatedTime += MAX_SEGMENT_DURATION_MS + 100
    capture.processAudioFrame(loudFrame)

    // The segment should have been closed at the limit to protect against OpenRouter 60s cap
    expect(segments.length).toBeGreaterThanOrEqual(1)
    expect(segments[0].durationMs).toBeGreaterThanOrEqual(MAX_SEGMENT_DURATION_MS)
    expect(segments[0].format).toBe("webm")

    capture.stop()
  })

  /*
   * A real `MediaRecorder.stop()` is asynchronous: the last `dataavailable`
   * and then `onstop` arrive after the call has returned. On the
   * `max_duration` path a new segment is started immediately — which reset
   * `segmentStartTime` and replaced the chunk array — so by the time `onstop`
   * ran it measured a segment that had just begun, decided it was shorter
   * than the minimum, and threw the audio away. Every sentence that ran past
   * the limit was silently dropped, and nothing anywhere said so.
   */
  test("una frase che supera il limite non viene persa quando onstop arriva dopo", async () => {
    let simulatedTime = 10_000
    const segments: CapturedSegment[] = []
    const pending: (() => void)[] = []

    /** A recorder that answers `stop()` the way a browser does: later. */
    class AsyncRecorder extends MockMediaRecorder {
      override stop(): void {
        this.stopCalls++
        this.state = "inactive"
        pending.push(() => {
          this.ondataavailable?.({ data: new Blob(["coda"], { type: this.mimeType }) })
          this.onstop?.()
        })
      }
    }

    const capture = createMicCapture({
      now: () => simulatedTime,
      mediaStream: new MockMediaStream([new MockMediaStreamTrack()]) as any,
      mediaRecorderClass: AsyncRecorder as any,
      isTypeSupported: () => true,
      onSegment: (seg) => {
        segments.push(seg)
      },
      speechDetectorConfig: {
        speechThreshold: 0.05,
        minSpeechDurationMs: 50,
        silenceDurationMs: 1200,
      },
    })

    await capture.start()
    const loud = new Float32Array(160).fill(0.5)

    capture.processAudioFrame(loud)
    simulatedTime += 100
    capture.processAudioFrame(loud)

    // Still talking when the limit is reached: the segment is split and a new
    // one begins in the same breath.
    simulatedTime += MAX_SEGMENT_DURATION_MS + 100
    capture.processAudioFrame(loud)

    // Only now does the browser get round to finishing the first one.
    for (const flush of pending.splice(0)) flush()

    expect(segments).toHaveLength(1)
    expect(segments[0].durationMs).toBeGreaterThanOrEqual(MAX_SEGMENT_DURATION_MS)

    capture.stop()
  })

  test("stop() strictly stops all MediaStreamTracks on the media stream", async () => {
    const track1 = new MockMediaStreamTrack()
    const track2 = new MockMediaStreamTrack()
    const stream = new MockMediaStream([track1, track2]) as any

    const capture = createMicCapture({
      mediaStream: stream,
      mediaRecorderClass: MockMediaRecorder as any,
      isTypeSupported: () => true,
    })

    await capture.start()
    expect(capture.isRunning).toBe(true)
    expect(track1.stopCalls).toBe(0)
    expect(track2.stopCalls).toBe(0)

    capture.stop()

    expect(capture.isRunning).toBe(false)
    // Both tracks must have been stopped
    expect(track1.stopCalls).toBe(1)
    expect(track2.stopCalls).toBe(1)
    expect(track1.readyState).toBe("ended")
    expect(track2.readyState).toBe("ended")
  })
})

describe("audio/capture pre-roll", () => {
  test("a detector-started segment keeps the audio from before speech was confirmed", async () => {
    let simulatedTime = 10_000
    const segments: CapturedSegment[] = []
    const capture = createMicCapture({
      now: () => simulatedTime,
      mediaStream: new MockMediaStream([new MockMediaStreamTrack()]) as any,
      mediaRecorderClass: MockMediaRecorder as any,
      isTypeSupported: () => true,
      preferredFormat: "wav",
      onSegment: (seg) => {
        segments.push(seg)
      },
      speechDetectorConfig: { speechThreshold: 0.05, minSpeechDurationMs: 200, silenceDurationMs: 300 },
    })
    await capture.start()

    const frame = 4096
    const quiet = new Float32Array(frame).fill(0)
    const loud = new Float32Array(frame).fill(0.5)

    // Room noise, then the first loud frame — which the detector does not
    // yet call speech — then the frame that confirms it.
    capture.processAudioFrame(quiet)
    simulatedTime += 256
    capture.processAudioFrame(loud)
    simulatedTime += 256
    capture.processAudioFrame(loud)
    simulatedTime += 256
    capture.processAudioFrame(loud)
    // Silence is measured from the first quiet frame, so it takes two.
    simulatedTime += 256
    capture.processAudioFrame(quiet)
    simulatedTime += 400
    capture.processAudioFrame(quiet)

    expect(segments).toHaveLength(1)
    const samples = (segments[0].blob.size - 44) / 2
    // Two confirmed frames plus the closing frame would be 3; the pre-roll
    // brings back the unconfirmed first syllable and the room tone before it.
    expect(samples).toBeGreaterThanOrEqual(frame * 4)
    capture.stop()
  })

  test("a segment started by a key press has no pre-roll", async () => {
    const segments: CapturedSegment[] = []
    let simulatedTime = 10_000
    const capture = createMicCapture({
      now: () => simulatedTime,
      mediaStream: new MockMediaStream([new MockMediaStreamTrack()]) as any,
      mediaRecorderClass: MockMediaRecorder as any,
      isTypeSupported: () => true,
      preferredFormat: "wav",
      onSegment: (seg) => {
        segments.push(seg)
      },
      speechDetectorConfig: { speechThreshold: 0.9 },
    })
    await capture.start()

    const frame = new Float32Array(1600).fill(0.1)
    capture.processAudioFrame(frame)
    capture.processAudioFrame(frame)
    capture.startSegment?.()
    simulatedTime += 200
    capture.processAudioFrame(frame)
    capture.commitSegment?.()

    expect(segments).toHaveLength(1)
    expect((segments[0].blob.size - 44) / 2).toBe(1600)
    capture.stop()
  })

  test("a level is published at most every interval, and not at all when it has not moved", async () => {
    let simulatedTime = 10_000
    const levels: number[] = []
    const capture = createMicCapture({
      now: () => simulatedTime,
      mediaStream: new MockMediaStream([new MockMediaStreamTrack()]) as any,
      mediaRecorderClass: MockMediaRecorder as any,
      isTypeSupported: () => true,
      levelIntervalMs: 50,
      levelEpsilon: LEVEL_EPSILON,
      speechDetectorConfig: { speechThreshold: 0.9 },
      onLevel: (level) => levels.push(level),
    })
    await capture.start()

    // A second of audio at 16 kHz, one 20 ms buffer at a time: 50 frames, the
    // rate the callback really arrives at. Every frame is the same loudness.
    const loud = new Float32Array(320).fill(0.5)
    for (let i = 0; i < 50; i++) {
      simulatedTime += 20
      capture.processAudioFrame(loud)
    }
    // One level for the first frame, and one per interval after it: not 50.
    expect(levels.length).toBeLessThanOrEqual(2)
    expect(levels.length).toBeGreaterThanOrEqual(1)
    // The rate a ring can draw is the ceiling, not the frame rate.
    expect(LEVEL_INTERVAL_MS).toBeGreaterThanOrEqual(20)

    // A level that moves is published as soon as the interval has passed.
    const quiet = new Float32Array(320).fill(0)
    simulatedTime += LEVEL_INTERVAL_MS
    capture.processAudioFrame(quiet)
    expect(levels.at(-1)).toBe(0)

    // Stopping says the microphone is closed without waiting for the interval.
    const before = levels.length
    capture.stop()
    expect(levels.length).toBe(before + 1)
    expect(levels.at(-1)).toBe(0)
  })

  test("a level within the epsilon of the last one is not published again", async () => {
    let simulatedTime = 10_000
    const levels: number[] = []
    const capture = createMicCapture({
      now: () => simulatedTime,
      mediaStream: new MockMediaStream([new MockMediaStreamTrack()]) as any,
      mediaRecorderClass: MockMediaRecorder as any,
      isTypeSupported: () => true,
      levelIntervalMs: 0,
      levelEpsilon: 0.05,
      speechDetectorConfig: { speechThreshold: 0.9 },
      onLevel: (level) => levels.push(level),
    })
    await capture.start()

    // No interval to wait out: only the epsilon decides.
    capture.processAudioFrame(new Float32Array(320).fill(0.5))
    capture.processAudioFrame(new Float32Array(320).fill(0.5))
    expect(levels).toHaveLength(1)

    // A real change goes straight through.
    capture.processAudioFrame(new Float32Array(320).fill(0.9))
    expect(levels).toHaveLength(2)
    expect(levels.at(-1)).toBeGreaterThan(0.5)
    capture.stop()
  })

  test("a microphone opened again inside the interval publishes its first level at once", async () => {
    let simulatedTime = 10_000
    const levels: number[] = []
    // `stop` lets the stream go, so reopening asks for one again — the way it
    // does in the app, where the microphone is opened and closed with the
    // listening.
    const capture = createMicCapture({
      now: () => simulatedTime,
      getUserMedia: async () => new MockMediaStream([new MockMediaStreamTrack()]) as any,
      mediaRecorderClass: MockMediaRecorder as any,
      isTypeSupported: () => true,
      levelIntervalMs: 50,
      levelEpsilon: LEVEL_EPSILON,
      speechDetectorConfig: { speechThreshold: 0.9 },
      onLevel: (level) => levels.push(level),
    })
    await capture.start()
    capture.processAudioFrame(new Float32Array(320).fill(0.5))
    capture.stop()

    // Reopened before the interval of the stop has passed: the zero that closed
    // it is not a level the new run has to wait behind.
    simulatedTime += 10
    levels.length = 0
    await capture.start()
    capture.processAudioFrame(new Float32Array(320).fill(0.5))
    expect(levels).toEqual([0.5])
    capture.stop()
  })
})

describe("audio/capture segment audio", () => {
  test("a detector-started segment reports start, the pre-roll frames, the new frames, end", async () => {
    let simulatedTime = 10_000
    const events: SegmentAudio[] = []
    const capture = createMicCapture({
      now: () => simulatedTime,
      mediaStream: new MockMediaStream([new MockMediaStreamTrack()]) as any,
      mediaRecorderClass: MockMediaRecorder as any,
      isTypeSupported: () => true,
      preferredFormat: "wav",
      onSegmentAudio: (event) => {
        events.push(event)
      },
      speechDetectorConfig: { speechThreshold: 0.05, minSpeechDurationMs: 200, silenceDurationMs: 300 },
    })
    await capture.start()

    const frame = 4096
    const quiet = new Float32Array(frame).fill(0)
    const loud = new Float32Array(frame).fill(0.5)

    capture.processAudioFrame(quiet)
    simulatedTime += 256
    capture.processAudioFrame(loud)
    simulatedTime += 256
    capture.processAudioFrame(loud)
    simulatedTime += 256
    capture.processAudioFrame(loud)
    simulatedTime += 256
    capture.processAudioFrame(quiet)
    simulatedTime += 400
    capture.processAudioFrame(quiet)
    capture.stop()

    expect(events.length).toBeGreaterThanOrEqual(4)
    expect(events[0].phase).toBe("start")
    expect(events[0].sequence).toBe(1)
    expect(events.at(-1)!.phase).toBe("end")
    expect(events.at(-1)!.sequence).toBe(1)
    // Everything between is a frame of the same segment.
    const frames = events.slice(1, -1)
    expect(frames.length).toBeGreaterThanOrEqual(3)
    for (const event of frames) {
      expect(event.phase).toBe("frame")
      expect(event.sequence).toBe(1)
      expect(event.pcm).toBeInstanceOf(Float32Array)
    }
    // The first frame is the room tone heard before the detector confirmed the
    // speech: it can only have arrived as pre-roll.
    expect(frames[0].pcm!.every((sample) => sample === 0)).toBe(true)
    // The closing frame never goes out after the end.
    expect(events.filter((event) => event.phase === "end")).toHaveLength(1)
    expect(events.filter((event) => event.phase === "cancel")).toHaveLength(0)
  })

  test("a segment started by a key press reports no pre-roll frames", async () => {
    const events: SegmentAudio[] = []
    let simulatedTime = 10_000
    const capture = createMicCapture({
      now: () => simulatedTime,
      mediaStream: new MockMediaStream([new MockMediaStreamTrack()]) as any,
      mediaRecorderClass: MockMediaRecorder as any,
      isTypeSupported: () => true,
      preferredFormat: "wav",
      speechDetectorConfig: { speechThreshold: 0.9 },
    })
    await capture.start()
    capture.onSegmentAudio((event) => {
      events.push(event)
    })

    const frame = new Float32Array(1600).fill(0.1)
    capture.processAudioFrame(frame)
    capture.processAudioFrame(frame)
    capture.startSegment?.()
    simulatedTime += 200
    capture.processAudioFrame(frame)
    capture.commitSegment?.()
    capture.stop()

    // Two frames went into the pre-roll before the key press: none of them is
    // reported, only the frame recorded after the press.
    expect(events.map((event) => event.phase)).toEqual(["start", "frame", "end"])
    expect(events[1].pcm!.length).toBe(1600)
    expect(events.every((event) => event.sequence === 1)).toBe(true)
  })

  test("a cancelled segment reports cancel instead of end, and a later segment gets its own sequence", async () => {
    const events: SegmentAudio[] = []
    const segments: CapturedSegment[] = []
    let simulatedTime = 10_000
    const capture = createMicCapture({
      now: () => simulatedTime,
      mediaStream: new MockMediaStream([new MockMediaStreamTrack()]) as any,
      mediaRecorderClass: MockMediaRecorder as any,
      isTypeSupported: () => true,
      preferredFormat: "wav",
      speechDetectorConfig: { speechThreshold: 0.9 },
      onSegment: (seg) => {
        segments.push(seg)
      },
      onSegmentAudio: (event) => {
        events.push(event)
      },
    })
    await capture.start()

    capture.startSegment?.()
    capture.processAudioFrame(new Float32Array(1600).fill(0.1))
    capture.cancelSegment?.()
    // Cancelling what is not being recorded reports nothing at all.
    capture.cancelSegment?.()

    capture.startSegment?.()
    simulatedTime += 200
    capture.processAudioFrame(new Float32Array(1600).fill(0.1))
    capture.commitSegment?.()
    capture.stop()

    expect(events.map((event) => `${event.phase}:${event.sequence}`)).toEqual([
      "start:1",
      "frame:1",
      "cancel:1",
      "start:2",
      "frame:2",
      "end:2",
    ])
    // The cancelled segment produced no audio: only the committed one.
    expect(segments).toHaveLength(1)
    expect(segments[0].sequence).toBe(2)
  })

  test("the end event carries the same keep-or-drop verdict the flush takes", async () => {
    const events: SegmentAudio[] = []
    const segments: CapturedSegment[] = []
    let simulatedTime = 10_000
    const capture = createMicCapture({
      now: () => simulatedTime,
      mediaStream: new MockMediaStream([new MockMediaStreamTrack()]) as any,
      mediaRecorderClass: MockMediaRecorder as any,
      isTypeSupported: () => true,
      speechDetectorConfig: { speechThreshold: 0.9 },
      onSegment: (seg) => {
        segments.push(seg)
      },
      onSegmentAudio: (event) => {
        events.push(event)
      },
    })
    await capture.start()

    // 100 ms of push-to-talk: under the 150 ms floor for an intentional
    // close, so the flush drops it — and the end already says so.
    capture.startSegment?.()
    simulatedTime += 100
    capture.processAudioFrame(new Float32Array(1600).fill(0.1))
    capture.commitSegment?.()
    expect(events.at(-1)!.phase).toBe("end")
    expect(events.at(-1)!.kept).toBe(false)
    expect(segments).toHaveLength(0)

    // Over the floor: the same verdict agrees with the delivery.
    capture.startSegment?.()
    simulatedTime += 300
    capture.processAudioFrame(new Float32Array(1600).fill(0.1))
    capture.commitSegment?.()
    capture.stop()
    expect(events.at(-1)!.phase).toBe("end")
    expect(events.at(-1)!.kept).toBe(true)
    expect(segments).toHaveLength(1)
  })
})
