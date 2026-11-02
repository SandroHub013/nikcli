/**
 * The voice engine, standing in for itself until someone asks for it.
 *
 * The engine is most of the voice package (the dialogue, the recognition, the
 * speakers, the Effect runtime) and a user who never turns the voice on never
 * needs a byte of it. But the bar's orb, the agent view and the key handler all
 * hold "the engine" from the first frame. This is that engine: it answers every
 * question a silent voice would answer ("not running, nothing heard, nothing
 * said") from signals of its own, and builds the real one the first time it is
 * asked to do something: start, toggle, press to talk, submit text, speak.
 *
 * Once the real engine exists every accessor reads it, through the `engine`
 * signal, so whatever drew the idle value draws the live one without being told.
 *
 * What it deliberately does not do is load the engine to be told to stop:
 * stopping, cancelling and releasing a key are things a voice that never started
 * has already done. The exception is a release that follows a press still being
 * loaded: it waits for the load, or the key would come up before the microphone
 * had been opened and the microphone would stay open.
 */

import { createSignal } from "solid-js"
import type { VoiceEngine, VoiceMode, VoiceSettings } from "@ragu/voice/core"

export interface LazyVoiceEngine extends VoiceEngine {
  /** Builds the real engine if it is not built yet, and gives it. */
  ensure(): Promise<VoiceEngine>
  /** Whether the real engine exists. Reactive. */
  readonly loaded: () => boolean
}

export interface LazyVoiceEngineOptions {
  /**
   * Builds the real engine. Called once, the first time a method needs it; a failure is not kept, so the next
   * request tries again.
   */
  load: () => Promise<VoiceEngine>
  /** The settings the engine would start with: what `settings()` answers until it exists. */
  settings: () => VoiceSettings
}

/** The engine's `DaySpend` before it has counted anything. */
const NO_SPEND = { day: "", calls: 0, cost: 0 } as const

export function createLazyVoiceEngine(options: LazyVoiceEngineOptions): LazyVoiceEngine {
  const [engine, setEngine] = createSignal<VoiceEngine | undefined>(undefined)
  /** The load in flight or done; cleared on failure so a later request tries again. */
  let loading: Promise<VoiceEngine> | undefined

  const ensure = (): Promise<VoiceEngine> => {
    const ready = engine()
    if (ready) return Promise.resolve(ready)
    loading ??= options
      .load()
      .then((built) => {
        setEngine(built)
        return built
      })
      .catch((error) => {
        loading = undefined
        throw error
      })
    return loading
  }

  /** Runs `call` on the engine once it is built, loading it if need be. */
  const withEngine = async <T>(call: (built: VoiceEngine) => Promise<T>): Promise<T> => call(await ensure())

  /** Runs `call` only if there is, or is about to be, an engine: a stop has nothing to do for a voice never started. */
  const ifEngine = async (call: (built: VoiceEngine) => Promise<void>): Promise<void> => {
    const ready = engine()
    if (ready) return call(ready)
    if (loading) return call(await loading)
  }

  const settings = (): VoiceSettings => engine()?.settings() ?? options.settings()

  return {
    ensure,
    loaded: () => engine() !== undefined,

    // Reactive state: the silent voice's answer until the engine exists, then the engine's own.
    status: () => engine()?.status() ?? "idle",
    partialTranscript: () => engine()?.partialTranscript() ?? "",
    lastSpoken: () => engine()?.lastSpoken() ?? "",
    lastOutcome: () => engine()?.lastOutcome(),
    micLevel: () => engine()?.micLevel() ?? 0,
    lastError: () => engine()?.lastError(),
    lastErrorKind: () => engine()?.lastErrorKind(),
    dialogState: () => engine()?.dialogState() ?? { status: "idle" },
    lastParseResult: () => engine()?.lastParseResult(),
    isRunning: () => engine()?.isRunning() ?? false,
    isBusy: () => engine()?.isBusy() ?? false,
    hearing: () => engine()?.hearing() ?? false,
    settings,
    activeMode: (): VoiceMode => engine()?.activeMode() ?? settings().mode,
    history: () => engine()?.history() ?? [],
    dictated: () => engine()?.dictated() ?? [],
    held: () => engine()?.held() ?? null,
    listenPaused: () => engine()?.listenPaused() ?? false,
    followUp: () => engine()?.followUp(),
    listenWarning: () => engine()?.listenWarning(),
    listenSpend: () => engine()?.listenSpend() ?? NO_SPEND,
    listenHalted: () => engine()?.listenHalted() ?? false,
    isLatched: () => engine()?.isLatched() ?? false,
    retryStream: () => engine()?.retryStream(),

    // What asks for the microphone, or for a voice, builds the engine.
    start: (mode, startOptions) => withEngine((built) => built.start(mode, startOptions)),
    toggle: (mode) => withEngine((built) => built.toggle(mode)),
    submitText: (text) => withEngine((built) => built.submitText(text)),
    pressToTalk: (mode) => withEngine((built) => built.pressToTalk(mode)),
    handlePermissionRequest: (paneId, what, requestOptions) =>
      withEngine((built) => built.handlePermissionRequest(paneId, what, requestOptions)),
    requestSendConfirmation: (id, to, text, lead) =>
      withEngine((built) => built.requestSendConfirmation(id, to, text, lead)),
    openResponseWindow: (windowOptions) => withEngine((built) => built.openResponseWindow(windowOptions)),

    // What ends something has nothing to end in a voice that never started.
    stop: () => ifEngine((built) => built.stop()),
    pauseListening: () => ifEngine((built) => built.pauseListening()),
    cancel: () => ifEngine((built) => built.cancel()),
    interrupt: () => ifEngine((built) => built.interrupt()),
    releaseToTalk: () => ifEngine((built) => built.releaseToTalk()),
    handlePermissionResolved: (paneId) => ifEngine((built) => built.handlePermissionResolved(paneId)),

    // A change of settings is not a reason to load: the engine is built from `options.settings()` of the moment.
    updateSettings: (next) => ifEngine((built) => built.updateSettings(next)),
  }
}
