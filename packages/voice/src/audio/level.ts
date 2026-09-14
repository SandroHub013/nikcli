/**
 * Pure audio signal processing and speech/silence detection.
 *
 * Designed to run in any JavaScript runtime (Node.js, Bun, Browser) without DOM
 * or Web Audio dependencies. All time inputs are explicitly injected.
 */

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/**
 * Default RMS threshold above which an audio frame is classified as voice/activity
 * rather than background room noise.
 */
export const DEFAULT_SPEECH_THRESHOLD = 0.025

/**
 * Duration of continuous silence (in milliseconds) after voice activity before
 * the utterance is considered concluded.
 */
export const DEFAULT_SILENCE_TIMEOUT_MS = 800

/**
 * Minimum duration of continuous audio activity (in milliseconds) required to
 * confirm intentional speech, filtering out short clicks or keyboard taps.
 */
export const DEFAULT_MIN_SPEECH_DURATION_MS = 120

// ---------------------------------------------------------------------------
// RMS Calculation
// ---------------------------------------------------------------------------

/**
 * Calculates the Root Mean Square (RMS) amplitude of a Float32Array PCM buffer.
 *
 * Returns 0.0 for empty buffers. Result is typically in the range [0.0, 1.0].
 */
export function calculateRms(samples: ArrayLike<number>): number {
  const len = samples.length
  if (len === 0) return 0.0

  let sumSquares = 0.0
  for (let i = 0; i < len; i++) {
    const val = samples[i]
    sumSquares += val * val
  }

  return Math.sqrt(sumSquares / len)
}

// ---------------------------------------------------------------------------
// Speech / Silence State Machine
// ---------------------------------------------------------------------------

export type SpeechState = "silent" | "speaking" | "speech_ended"

export interface SpeechDetectorConfig {
  /** RMS threshold for voice detection (default: DEFAULT_SPEECH_THRESHOLD). */
  speechThreshold?: number
  /** Silence duration in ms to trigger 'speech_ended' (default: DEFAULT_SILENCE_TIMEOUT_MS). */
  silenceDurationMs?: number
  /** Minimum activity duration in ms to confirm 'speaking' (default: DEFAULT_MIN_SPEECH_DURATION_MS). */
  minSpeechDurationMs?: number
}

export interface SpeechDetectorState {
  status: SpeechState
  speechStartTime?: number
  lastSpeechTime?: number
  silenceStartTime?: number
}

export function createInitialSpeechDetectorState(): SpeechDetectorState {
  return {
    status: "silent",
  }
}

/**
 * Pure transition function for speech and silence boundary detection.
 *
 * @param state Previous detector state
 * @param level Current RMS audio amplitude
 * @param now Injected current timestamp (epoch ms or performance timer)
 * @param config Optional tuning thresholds
 */
export function stepSpeechDetector(
  state: SpeechDetectorState,
  level: number,
  now: number,
  config: SpeechDetectorConfig = {}
): SpeechDetectorState {
  const threshold = config.speechThreshold ?? DEFAULT_SPEECH_THRESHOLD
  const silenceTimeout = config.silenceDurationMs ?? DEFAULT_SILENCE_TIMEOUT_MS
  const minSpeechDuration = config.minSpeechDurationMs ?? DEFAULT_MIN_SPEECH_DURATION_MS

  const isLoud = level >= threshold

  // Case 1: Audio level above threshold (speech or loud transient)
  if (isLoud) {
    // If was silent: candidate speech started
    if (state.status === "silent") {
      const startTime = state.speechStartTime ?? now
      const elapsed = now - startTime

      if (elapsed >= minSpeechDuration) {
        return {
          status: "speaking",
          speechStartTime: startTime,
          lastSpeechTime: now,
          silenceStartTime: undefined,
        }
      }

      return {
        ...state,
        speechStartTime: startTime,
        silenceStartTime: undefined,
      }
    }

    // If was already speaking: refresh last speech time
    if (state.status === "speaking") {
      return {
        ...state,
        lastSpeechTime: now,
        silenceStartTime: undefined,
      }
    }

    // If was speech_ended: new speech started
    if (state.status === "speech_ended") {
      return {
        status: "speaking",
        speechStartTime: now,
        lastSpeechTime: now,
        silenceStartTime: undefined,
      }
    }
  }

  // Case 2: Audio level below threshold (silence / ambient)
  if (state.status === "silent") {
    // Transient click died down before reaching minSpeechDuration: reset
    return {
      status: "silent",
      speechStartTime: undefined,
      silenceStartTime: undefined,
    }
  }

  if (state.status === "speaking") {
    const silenceStart = state.silenceStartTime ?? now
    const silenceDuration = now - silenceStart

    if (silenceDuration >= silenceTimeout) {
      return {
        status: "speech_ended",
        speechStartTime: undefined,
        lastSpeechTime: state.lastSpeechTime,
        silenceStartTime: silenceStart,
      }
    }

    return {
      ...state,
      silenceStartTime: silenceStart,
    }
  }

  // State remains speech_ended until explicit reset or new speech starts
  return state
}

/**
 * State container wrapping stepSpeechDetector for stateful usage.
 */
export function createSpeechDetector(config: SpeechDetectorConfig = {}) {
  let state = createInitialSpeechDetectorState()

  return {
    getState(): Readonly<SpeechDetectorState> {
      return state
    },

    step(level: number, now: number): SpeechState {
      state = stepSpeechDetector(state, level, now, config)
      return state.status
    },

    reset(): void {
      state = createInitialSpeechDetectorState()
    },
  }
}
