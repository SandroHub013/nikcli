import { describe, expect, test } from "bun:test"
import {
  calculateRms,
  createInitialSpeechDetectorState,
  createSpeechDetector,
  DEFAULT_MIN_SPEECH_DURATION_MS,
  DEFAULT_SILENCE_TIMEOUT_MS,
  DEFAULT_SPEECH_THRESHOLD,
  stepSpeechDetector,
} from "./level"

describe("audio/level calculateRms", () => {
  test("returns 0.0 for empty arrays", () => {
    expect(calculateRms(new Float32Array(0))).toBe(0.0)
    expect(calculateRms([])).toBe(0.0)
  })

  test("returns 0.0 for all zero samples", () => {
    const zeroes = new Float32Array([0, 0, 0, 0, 0])
    expect(calculateRms(zeroes)).toBe(0.0)
  })

  test("calculates correct RMS for constant DC signals", () => {
    const ones = new Float32Array([1.0, 1.0, 1.0, 1.0])
    expect(calculateRms(ones)).toBeCloseTo(1.0, 5)

    const halves = new Float32Array([0.5, 0.5, 0.5, 0.5])
    expect(calculateRms(halves)).toBeCloseTo(0.5, 5)

    const negative = new Float32Array([-0.8, -0.8, 0.8, 0.8])
    expect(calculateRms(negative)).toBeCloseTo(0.8, 5)
  })

  test("calculates correct RMS for varying waveform", () => {
    // [1, -1, 1, -1]: squares are 1, sum is 4, mean is 1, sqrt is 1
    const alternating = new Float32Array([1, -1, 1, -1])
    expect(calculateRms(alternating)).toBeCloseTo(1.0, 5)

    // [0, 2, 0, 2]: squares [0, 4, 0, 4], sum 8, mean 2, sqrt(2) = 1.4142...
    const wave = new Float32Array([0, 2, 0, 2])
    expect(calculateRms(wave)).toBeCloseTo(Math.SQRT2, 4)
  })
})

describe("audio/level speech and silence state machine", () => {
  const config = {
    speechThreshold: 0.03,
    silenceDurationMs: 1000,
    minSpeechDurationMs: 100,
  }

  test("initial state is silent", () => {
    const initial = createInitialSpeechDetectorState()
    expect(initial.status).toBe("silent")
  })

  test("short transient click below minSpeechDuration returns to silent", () => {
    let state = createInitialSpeechDetectorState()

    // Loud click at t=1000
    state = stepSpeechDetector(state, 0.1, 1000, config)
    expect(state.status).toBe("silent")
    expect(state.speechStartTime).toBe(1000)

    // Level drops back to quiet at t=1050 (only 50ms elapsed, < 100ms min)
    state = stepSpeechDetector(state, 0.01, 1050, config)
    expect(state.status).toBe("silent")
    expect(state.speechStartTime).toBeUndefined()
  })

  test("sustained audio level above threshold enters speaking state", () => {
    let state = createInitialSpeechDetectorState()

    // Sound begins at t=1000
    state = stepSpeechDetector(state, 0.05, 1000, config)
    expect(state.status).toBe("silent")

    // Sound continues at t=1120 (120ms > 100ms)
    state = stepSpeechDetector(state, 0.06, 1120, config)
    expect(state.status).toBe("speaking")
    expect(state.speechStartTime).toBe(1000)
    expect(state.lastSpeechTime).toBe(1120)
  })

  test("entering silence starts timer and transitions to speech_ended when duration passes", () => {
    let state = createInitialSpeechDetectorState()

    // Start speaking at t=1000, confirmed at t=1150
    state = stepSpeechDetector(state, 0.05, 1000, config)
    state = stepSpeechDetector(state, 0.05, 1150, config)
    expect(state.status).toBe("speaking")

    // Speech continues at t=2000
    state = stepSpeechDetector(state, 0.08, 2000, config)
    expect(state.status).toBe("speaking")
    expect(state.lastSpeechTime).toBe(2000)

    // User stops talking at t=2100 (< threshold)
    state = stepSpeechDetector(state, 0.01, 2100, config)
    expect(state.status).toBe("speaking")
    expect(state.silenceStartTime).toBe(2100)

    // At t=2600, only 500ms of silence (< 1000ms timeout)
    state = stepSpeechDetector(state, 0.01, 2600, config)
    expect(state.status).toBe("speaking")

    // At t=3100, exactly 1000ms of silence elapsed (3100 - 2100 = 1000)
    state = stepSpeechDetector(state, 0.01, 3100, config)
    expect(state.status).toBe("speech_ended")
  })

  test("resuming speech before silence duration expires resets silence timer", () => {
    let state = createInitialSpeechDetectorState()

    state = stepSpeechDetector(state, 0.05, 1000, config)
    state = stepSpeechDetector(state, 0.05, 1150, config)
    expect(state.status).toBe("speaking")

    // Silence starts at t=2000
    state = stepSpeechDetector(state, 0.01, 2000, config)
    expect(state.silenceStartTime).toBe(2000)

    // User resumes speaking at t=2400 (only 400ms silence)
    state = stepSpeechDetector(state, 0.07, 2400, config)
    expect(state.status).toBe("speaking")
    expect(state.silenceStartTime).toBeUndefined()
    expect(state.lastSpeechTime).toBe(2400)
  })

  test("new speech after speech_ended restarts speaking cycle", () => {
    let state = createInitialSpeechDetectorState()

    // Speak then end
    state = stepSpeechDetector(state, 0.05, 1000, config)
    state = stepSpeechDetector(state, 0.05, 1150, config)
    state = stepSpeechDetector(state, 0.01, 2200, config)
    state = stepSpeechDetector(state, 0.01, 3300, config)
    expect(state.status).toBe("speech_ended")

    // New utterance begins at t=5000
    state = stepSpeechDetector(state, 0.09, 5000, config)
    expect(state.status).toBe("speaking")
    expect(state.speechStartTime).toBe(5000)
  })

  test("createSpeechDetector wrapper tracks stateful updates", () => {
    const detector = createSpeechDetector({
      speechThreshold: 0.04,
      silenceDurationMs: 500,
      minSpeechDurationMs: 50,
    })

    expect(detector.step(0.01, 0)).toBe("silent")
    expect(detector.step(0.05, 10)).toBe("silent")
    expect(detector.step(0.05, 70)).toBe("speaking")
    expect(detector.step(0.01, 100)).toBe("speaking")
    expect(detector.step(0.01, 650)).toBe("speech_ended")

    detector.reset()
    expect(detector.getState().status).toBe("silent")
  })
})
