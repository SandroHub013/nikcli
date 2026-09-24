import { describe, expect, test } from "bun:test"
import {
  createParakeetTranscriber,
  describeParakeetReadiness,
  disposeParakeetModel,
  isParakeetModelWarmedUp,
  isWasmAvailable,
  isWebGpuAvailable,
  warmupParakeetModel,
  type ParakeetProgress,
} from "./parakeet-local"
import { createMicCapture } from "../audio/capture"
import { hasRequiredFiles } from "./model-cache"

class MockStreamingTranscriber {
  processCalls = 0
  finalizeCalls = 0
  resetCalls = 0

  async processChunk(_chunk: Float32Array) {
    this.processCalls++
    return {
      chunkText: "ciao",
      text: "ciao mondo",
      words: ["ciao", "mondo"],
      is_final: false,
      totalDuration: 0.5,
    }
  }

  finalize() {
    this.finalizeCalls++
    return {
      text: "ciao mondo definitivo",
      words: ["ciao", "mondo", "definitivo"],
    }
  }

  reset() {
    this.resetCalls++
  }
}

class MockParakeetModel {
  backend: string
  disposed = false
  streaming = new MockStreamingTranscriber()

  constructor(backend: string) {
    this.backend = backend
  }

  createStreamingTranscriber(_opts?: any) {
    return this.streaming
  }

  async dispose() {
    this.disposed = true
  }
}

describe("asr/parakeet-local", () => {
  test("cache readiness requires the exact files for the selected variant", () => {
    const required = ["encoder-model.int8.onnx", "decoder_joint-model.int8.onnx", "vocab.txt"]
    const keys = [
      "hf-ysdede/parakeet-tdt-0.6b-v3-onnx-rev-main-encoder-model.int8.onnx",
      "hf-ysdede/parakeet-tdt-0.6b-v3-onnx-rev-main-decoder_joint-model.int8.onnx",
      "hf-ysdede/parakeet-tdt-0.6b-v3-onnx-rev-main-vocab.txt",
    ]
    expect(hasRequiredFiles(keys, required)).toBe(true)
    expect(hasRequiredFiles(keys.slice(1), required)).toBe(false)
    expect(hasRequiredFiles(["hf-repo-rev-encoder-model.fp16.onnx", "hf-repo-rev-decoder_joint-model.int8.onnx", "hf-repo-rev-vocab.txt"], required)).toBe(false)
    expect(hasRequiredFiles([keys[0]!, keys[1]!.replace("rev-main", "rev-other"), keys[2]!], required)).toBe(false)
  })

  test("readiness reports usable when WASM or WebGPU available, and explains when model is not downloaded", () => {
    // Current runtime has WebAssembly
    expect(isWasmAvailable()).toBe(true)

    // Ready with model already downloaded
    const ready = describeParakeetReadiness({ isModelDownloaded: true })
    expect(ready.usable).toBe(true)

    // Model not yet downloaded
    const pendingDownload = describeParakeetReadiness({ isModelDownloaded: false })
    expect(pendingDownload.usable).toBe(false)
    expect(pendingDownload.reason).toContain("non è ancora stato scaricato in locale")
  })

  test("produces partial hypotheses from processChunk and final event from finalize", async () => {
    const mockModel = new MockParakeetModel("webgpu")
    const partials: string[] = []
    const finals: any[] = []

    // Fake capture to push audio chunks directly
    const capture = createMicCapture({
      mediaStream: {
        getTracks: () => [{ stop: () => {}, readyState: "live" }],
      } as any,
      isTypeSupported: () => true,
    })

    const transcriber = createParakeetTranscriber({
      capture,
      fromHub: async () => mockModel,
      supportsLanguage: () => true,
      onPartial: (text) => partials.push(text),
      onFinal: (evt) => finals.push(evt),
    })

    await transcriber.start()
    expect(transcriber.activeBackend).toBe("wasm") // Navigator.gpu not present in test runner

    // Feed a PCM chunk
    capture.processAudioFrame(new Float32Array(160).fill(0.1))

    // Allow async processChunk to settle
    await new Promise((r) => setTimeout(r, 10))

    expect(partials).toEqual(["ciao mondo"])
    expect(finals).toHaveLength(0)

    // Trigger silence end
    capture.processAudioFrame(new Float32Array(160).fill(0.0))
    // Call onSpeechEnd callback manually to test finalize pipeline
    ;(capture as any).stop()

    // Stop transcriber
    await transcriber.stop()
    expect(mockModel.disposed).toBe(true)
  })

  test("falls back to WASM when WebGPU initialization throws and declares WASM in activeBackend", async () => {
    const attempts: string[] = []
    const wasmModel = new MockParakeetModel("wasm")

    const fakeFromHub = async (_modelId: string, opts: any) => {
      attempts.push(opts.backend)
      if (opts.backend === "webgpu") {
        throw new Error("WebGPU initialization failed: GPU adapter not found")
      }
      return wasmModel
    }

    // Mock navigator.gpu temporarily
    const originalNavigator = globalThis.navigator
    ;(globalThis as any).navigator = {
      ...(originalNavigator || {}),
      gpu: {},
    }

    try {
      expect(isWebGpuAvailable()).toBe(true)

      const transcriber = createParakeetTranscriber({
        fromHub: fakeFromHub,
        supportsLanguage: () => true,
        captureOptions: {
          mediaStream: {
            getTracks: () => [],
          } as any,
          isTypeSupported: () => true,
        },
      })

      await transcriber.start()

      // Should have attempted webgpu first, then fallen back to wasm
      expect(attempts).toContain("webgpu")
      expect(attempts).toContain("wasm")
      expect(transcriber.activeBackend).toBe("wasm")
      expect(transcriber.statusMessage).toContain("wasm")

      await transcriber.stop()
    } finally {
      ;(globalThis as any).navigator = originalNavigator
    }
  })

  test("reports download progress and Italian preparation message to caller", async () => {
    const progressList: ParakeetProgress[] = []
    const mockModel = new MockParakeetModel("wasm")

    const fakeFromHub = async (_modelId: string, opts: any) => {
      opts.progress?.({ loaded: 250_000_000, total: 500_000_000, file: "model.onnx" })
      opts.progress?.({ loaded: 500_000_000, total: 500_000_000, file: "model.onnx" })
      return mockModel
    }

    const transcriber = createParakeetTranscriber({
      fromHub: fakeFromHub,
      supportsLanguage: () => true,
      onProgress: (p) => progressList.push(p),
      captureOptions: {
        mediaStream: { getTracks: () => [] } as any,
        isTypeSupported: () => true,
      },
    })

    await transcriber.start()

    expect(progressList.length).toBeGreaterThanOrEqual(2)
    // First message indicates preparation
    expect(progressList[0].message).toContain("Preparazione")
    // Subsequent reports include percentage
    const lastProgress = progressList[progressList.length - 1]
    expect(lastProgress.percent).toBe(100)
    expect(lastProgress.message).toContain("100%")

    await transcriber.stop()
  })

  test("rejects when the chosen language is not supported by the model", async () => {
    const errors: Error[] = []

    const transcriber = createParakeetTranscriber({
      fromHub: async () => new MockParakeetModel("wasm"),
      supportsLanguage: () => false, // Claims the language is not supported
      onError: (err) => errors.push(err),
      captureOptions: {
        mediaStream: { getTracks: () => [] } as any,
        isTypeSupported: () => true,
      },
    })

    // Both: reported to the listener and rejected, so a caller that awaited
    // start() cannot go on believing the microphone is live.
    await expect(transcriber.start()).rejects.toThrow(/non supporta la lingua scelta \('it'\)/)

    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain("non supporta la lingua scelta ('it')")
  })

  /*
   * The check used to name `"it"` whatever the user had picked, so a model
   * that speaks the chosen language but not Italian was refused, and one that
   * speaks Italian but not the chosen language was loaded and then transcribed
   * badly with nothing to explain it.
   */
  test("the coverage question names the language the user chose", async () => {
    const asked: string[][] = []

    const transcriber = createParakeetTranscriber({
      language: "en",
      fromHub: async () => new MockParakeetModel("wasm"),
      supportsLanguage: (id: string, code: string) => {
        asked.push([id, code])
        return code === "en"
      },
      captureOptions: {
        mediaStream: { getTracks: () => [] } as any,
        isTypeSupported: () => true,
      },
    })

    await transcriber.start()

    expect(asked.map(([, code]) => code)).toEqual(["en"])
    await transcriber.stop()
  })

  test("'auto' asks nothing, because there is no single code to ask about", async () => {
    let asked = 0

    const transcriber = createParakeetTranscriber({
      language: "auto",
      fromHub: async () => new MockParakeetModel("wasm"),
      supportsLanguage: () => {
        asked += 1
        return false // Would refuse the load if it were consulted at all.
      },
      captureOptions: {
        mediaStream: { getTracks: () => [] } as any,
        isTypeSupported: () => true,
      },
    })

    await transcriber.start()

    expect(asked).toBe(0)
    await transcriber.stop()
  })

  describe("in-memory caching & warmup lifecycle", () => {
    test("keeps model warm across sessions and avoids repeated fromHub downloads and progress events", async () => {
      await disposeParakeetModel()
      expect(isParakeetModelWarmedUp()).toBe(false)

      let fromHubCalls = 0
      const mockModel = new MockParakeetModel("wasm")
      const fakeFromHub = async () => {
        fromHubCalls++
        return mockModel
      }

      const progressHistory1: ParakeetProgress[] = []
      const transcriber1 = createParakeetTranscriber({
        keepWarm: true,
        fromHub: fakeFromHub,
        supportsLanguage: () => true,
        onProgress: (p) => progressHistory1.push(p),
        captureOptions: {
          mediaStream: { getTracks: () => [] } as any,
          isTypeSupported: () => true,
        },
      })

      // 1. First start: loads model via fromHub, emits progress
      await transcriber1.start()
      expect(fromHubCalls).toBe(1)
      expect(progressHistory1.length).toBeGreaterThan(0)
      expect(isParakeetModelWarmedUp()).toBe(true)

      // Stop transcriber 1: with keepWarm=true, mockModel is NOT disposed
      await transcriber1.stop()
      expect(mockModel.disposed).toBe(false)
      expect(isParakeetModelWarmedUp()).toBe(true)

      // 2. Second start with new transcriber instance: reuses warm model instantly
      const progressHistory2: ParakeetProgress[] = []
      const transcriber2 = createParakeetTranscriber({
        keepWarm: true,
        fromHub: fakeFromHub,
        supportsLanguage: () => true,
        onProgress: (p) => progressHistory2.push(p),
        captureOptions: {
          mediaStream: { getTracks: () => [] } as any,
          isTypeSupported: () => true,
        },
      })

      await transcriber2.start()
      // fromHub was NOT called again!
      expect(fromHubCalls).toBe(1)
      // No progress loading callbacks fired (instant 0ms reuse!)
      expect(progressHistory2).toEqual([])

      await transcriber2.stop()
      expect(mockModel.disposed).toBe(false)

      // 3. disposeParakeetModel clears the cache and releases the model
      await disposeParakeetModel()
      expect(isParakeetModelWarmedUp()).toBe(false)
      expect(mockModel.disposed).toBe(true)
    })

    test("replacing the shared model releases the previous one", async () => {
      await disposeParakeetModel()
      const first = new MockParakeetModel("wasm")
      const second = new MockParakeetModel("wasm")
      const firstTranscriber = createParakeetTranscriber({
        modelId: "first",
        keepWarm: true,
        fromHub: async () => first,
        supportsLanguage: () => true,
        captureOptions: { mediaStream: { getTracks: () => [] } as unknown as MediaStream, isTypeSupported: () => true },
      })
      await firstTranscriber.start()
      expect(first.disposed).toBe(false)

      const secondTranscriber = createParakeetTranscriber({
        modelId: "second",
        keepWarm: true,
        fromHub: async () => second,
        supportsLanguage: () => true,
        captureOptions: { mediaStream: { getTracks: () => [] } as unknown as MediaStream, isTypeSupported: () => true },
      })
      await secondTranscriber.start()

      expect(first.disposed).toBe(true)
      expect(second.disposed).toBe(false)
      await secondTranscriber.stop()
      await disposeParakeetModel()
    })

    test("dispose waits for an in-flight model and does not reinstall it", async () => {
      await disposeParakeetModel()
      let resolveModel: ((model: MockParakeetModel) => void) | undefined
      let fromHubStarted = false
      const modelPromise = new Promise<MockParakeetModel>((resolve) => {
        resolveModel = resolve
      })
      const transcriber = createParakeetTranscriber({
        keepWarm: true,
        fromHub: async () => {
          fromHubStarted = true
          return modelPromise
        },
        supportsLanguage: () => true,
        captureOptions: { mediaStream: { getTracks: () => [] } as unknown as MediaStream, isTypeSupported: () => true },
      })

      const starting = transcriber.start()
      while (!fromHubStarted) await new Promise((resolve) => setTimeout(resolve, 0))
      const disposing = disposeParakeetModel()
      const model = new MockParakeetModel("wasm")
      resolveModel?.(model)
      await disposing
      await expect(starting).rejects.toThrow()
      expect(model.disposed).toBe(true)
      expect(isParakeetModelWarmedUp()).toBe(false)
    })

    test("stop during Parakeet initialization can restart cleanly", async () => {
      await disposeParakeetModel()
      const errors: Error[] = []
      let resolveFirst: ((model: MockParakeetModel) => void) | undefined
      let fromHubCalls = 0
      const first = new MockParakeetModel("wasm")
      const second = new MockParakeetModel("wasm")
      const firstModel = new Promise<MockParakeetModel>((resolve) => {
        resolveFirst = resolve
      })
      const transcriber = createParakeetTranscriber({
        keepWarm: true,
        fromHub: async () => {
          fromHubCalls++
          return fromHubCalls === 1 ? firstModel : second
        },
        supportsLanguage: () => true,
        onError: (error) => errors.push(error),
        captureOptions: {
          getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
          isTypeSupported: () => true,
        },
      })

      const firstStart = transcriber.start()
      while (fromHubCalls === 0) await new Promise((resolve) => setTimeout(resolve, 0))
      await transcriber.stop()
      const disposing = disposeParakeetModel()
      resolveFirst?.(first)
      await disposing
      await firstStart

      expect(first.disposed).toBe(true)
      expect(errors).toEqual([])
      await transcriber.start()
      expect(transcriber.isReady).toBe(true)
      expect(errors).toEqual([])

      await transcriber.stop()
      await disposeParakeetModel()
    })

    test("stop while the microphone opens releases the late stream before restart", async () => {
      await disposeParakeetModel()
      const model = new MockParakeetModel("wasm")
      let releaseFirst: ((stream: MediaStream) => void) | undefined
      let getUserMediaCalls = 0
      let firstStopped = 0
      let secondStopped = 0
      const firstMedia = new Promise<MediaStream>((resolve) => {
        releaseFirst = resolve
      })
      const transcriber = createParakeetTranscriber({
        keepWarm: true,
        fromHub: async () => model,
        supportsLanguage: () => true,
        captureOptions: {
          getUserMedia: async () => {
            getUserMediaCalls++
            if (getUserMediaCalls === 1) return firstMedia
            return {
              getTracks: () => [{ stop: () => secondStopped++ }],
            } as unknown as MediaStream
          },
          isTypeSupported: () => true,
        },
      })

      const firstStart = transcriber.start()
      while (getUserMediaCalls === 0) await new Promise((resolve) => setTimeout(resolve, 0))
      await transcriber.stop()
      const secondStart = transcriber.start()
      await new Promise((resolve) => setTimeout(resolve, 0))
      const callsBeforeFirstResolved = getUserMediaCalls
      releaseFirst?.({
        getTracks: () => [{ stop: () => firstStopped++ }],
      } as unknown as MediaStream)
      await Promise.all([firstStart, secondStart])

      expect(callsBeforeFirstResolved).toBe(1)
      expect(getUserMediaCalls).toBe(2)
      expect(firstStopped).toBe(1)
      expect(secondStopped).toBe(0)
      expect(transcriber.isReady).toBe(true)
      await transcriber.stop()
      await disposeParakeetModel()
    })

    test("stop during model loading suppresses late readiness without disposal", async () => {
      await disposeParakeetModel()
      const errors: Error[] = []
      const backends: string[] = []
      let releaseModel: ((model: MockParakeetModel) => void) | undefined
      let loadStarted: (() => void) | undefined
      const entered = new Promise<void>((resolve) => {
        loadStarted = resolve
      })
      const modelPromise = new Promise<MockParakeetModel>((resolve) => {
        releaseModel = resolve
      })
      const transcriber = createParakeetTranscriber({
        keepWarm: true,
        fromHub: async () => {
          loadStarted?.()
          return modelPromise
        },
        supportsLanguage: () => true,
        onBackendChange: (backend) => backends.push(backend),
        onError: (error) => errors.push(error),
        captureOptions: {
          getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
          isTypeSupported: () => true,
        },
      })

      const firstStart = transcriber.start()
      await entered
      await transcriber.stop()
      releaseModel?.(new MockParakeetModel("wasm"))
      await firstStart

      expect(transcriber.isReady).toBe(false)
      expect(transcriber.statusMessage).toBe("Fermato")
      expect(backends).toEqual([])
      expect(errors).toEqual([])

      await transcriber.start()
      expect(transcriber.isReady).toBe(true)
      await transcriber.stop()
      await disposeParakeetModel()
    })

    test("a stopped shared-init waiter does not publish late readiness", async () => {
      await disposeParakeetModel()
      const errors: Error[] = []
      const waiterBackends: string[] = []
      let releaseModel: ((model: MockParakeetModel) => void) | undefined
      let loadStarted: (() => void) | undefined
      const entered = new Promise<void>((resolve) => {
        loadStarted = resolve
      })
      const modelPromise = new Promise<MockParakeetModel>((resolve) => {
        releaseModel = resolve
      })
      const captureOptions = {
        getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
        isTypeSupported: () => true,
      }
      const owner = createParakeetTranscriber({
        keepWarm: true,
        fromHub: async () => {
          loadStarted?.()
          return modelPromise
        },
        supportsLanguage: () => true,
        onError: (error) => errors.push(error),
        captureOptions,
      })
      const waiter = createParakeetTranscriber({
        keepWarm: true,
        fromHub: async () => {
          throw new Error("waiter loaded its own model")
        },
        supportsLanguage: () => true,
        onBackendChange: (backend) => waiterBackends.push(backend),
        onError: (error) => errors.push(error),
        captureOptions,
      })

      const ownerStart = owner.start()
      await entered
      const waiterStart = waiter.start()
      await waiter.stop()
      releaseModel?.(new MockParakeetModel("wasm"))
      await Promise.all([ownerStart, waiterStart])

      expect(waiter.isReady).toBe(false)
      expect(waiter.statusMessage).toBe("Fermato")
      expect(waiterBackends).toEqual([])
      expect(errors).toEqual([])
      await owner.stop()
      await waiter.stop()
      await disposeParakeetModel()
    })

    test("stop before preparation resumes discards initial progress", async () => {
      await disposeParakeetModel()
      const progress: ParakeetProgress[] = []
      const errors: Error[] = []
      const transcriber = createParakeetTranscriber({
        keepWarm: true,
        persistStorage: false,
        fromHub: async () => new MockParakeetModel("wasm"),
        supportsLanguage: () => true,
        onProgress: (update) => progress.push(update),
        onError: (error) => errors.push(error),
        captureOptions: {
          getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
          isTypeSupported: () => true,
        },
      })

      const starting = transcriber.start()
      await transcriber.stop()
      await starting

      expect(progress).toEqual([])
      expect(errors).toEqual([])
      expect(transcriber.statusMessage).toBe("Fermato")
      await disposeParakeetModel()
    })

    test("a stopped loader discards late progress and failure", async () => {
      await disposeParakeetModel()
      const progress: ParakeetProgress[] = []
      const errors: Error[] = []
      let finishLoad: (() => void) | undefined
      let loadStarted: (() => void) | undefined
      const entered = new Promise<void>((resolve) => {
        loadStarted = resolve
      })
      const gate = new Promise<void>((resolve) => {
        finishLoad = resolve
      })
      const transcriber = createParakeetTranscriber({
        keepWarm: true,
        fromHub: async (
          _modelId: string,
          options: { progress?: (progress: { loaded: number; total: number; file?: string }) => void },
        ) => {
          loadStarted?.()
          await gate
          options.progress?.({ loaded: 50, total: 100 })
          throw new Error("late model failure")
        },
        supportsLanguage: () => true,
        onProgress: (update) => progress.push(update),
        onError: (error) => errors.push(error),
        captureOptions: {
          getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
          isTypeSupported: () => true,
        },
      })

      const starting = transcriber.start()
      await entered
      await transcriber.stop()
      const progressAtStop = progress.length
      finishLoad?.()
      await starting

      expect(transcriber.statusMessage).toBe("Fermato")
      expect(progress).toHaveLength(progressAtStop)
      expect(errors).toEqual([])
      await disposeParakeetModel()
    })

    test("dispose during replacement cleanup cancels the replacement load", async () => {
      await disposeParakeetModel()
      let releaseOld: (() => void) | undefined
      let oldDisposeStarted: (() => void) | undefined
      const oldReleased = new Promise<void>((resolve) => {
        releaseOld = resolve
      })
      const oldDisposeEntered = new Promise<void>((resolve) => {
        oldDisposeStarted = resolve
      })
      const old = new MockParakeetModel("wasm")
      old.dispose = async () => {
        oldDisposeStarted?.()
        await oldReleased
        old.disposed = true
      }
      const warm = createParakeetTranscriber({
        keepWarm: true,
        fromHub: async () => old,
        supportsLanguage: () => true,
        captureOptions: {
          getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
          isTypeSupported: () => true,
        },
      })
      await warm.start()
      await warm.stop()

      const replacement = new MockParakeetModel("wasm")
      let replacementLoads = 0
      const next = createParakeetTranscriber({
        modelId: "replacement",
        keepWarm: true,
        fromHub: async () => {
          replacementLoads++
          return replacement
        },
        supportsLanguage: () => true,
        captureOptions: {
          getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
          isTypeSupported: () => true,
        },
      })
      try {
        const starting = Promise.resolve(next.start())
        await oldDisposeEntered
        await disposeParakeetModel()
        releaseOld?.()
        const failure = await starting.then(() => undefined, (error: unknown) => error)
        expect(failure).toBeInstanceOf(Error)
        expect(replacementLoads).toBe(0)
        expect(isParakeetModelWarmedUp()).toBe(false)
      } finally {
        await next.stop()
        await disposeParakeetModel()
      }
    })

    test("a start superseded by stop and restart cannot reopen the microphone", async () => {
      await disposeParakeetModel()
      const errors: Error[] = []
      let releaseModel: ((model: MockParakeetModel) => void) | undefined
      let loadStarted: (() => void) | undefined
      const entered = new Promise<void>((resolve) => {
        loadStarted = resolve
      })
      const modelPromise = new Promise<MockParakeetModel>((resolve) => {
        releaseModel = resolve
      })
      let microphoneStarts = 0
      const transcriber = createParakeetTranscriber({
        keepWarm: true,
        fromHub: async () => {
          loadStarted?.()
          return modelPromise
        },
        supportsLanguage: () => true,
        onError: (error) => errors.push(error),
        captureOptions: {
          getUserMedia: async () => {
            microphoneStarts++
            return { getTracks: () => [] } as unknown as MediaStream
          },
          isTypeSupported: () => true,
        },
      })

      const firstStart = transcriber.start()
      await entered
      await transcriber.stop()
      const secondStart = transcriber.start()
      releaseModel?.(new MockParakeetModel("wasm"))
      await Promise.all([firstStart, secondStart])

      expect(microphoneStarts).toBe(1)
      expect(transcriber.isReady).toBe(true)
      expect(errors).toEqual([])
      await transcriber.stop()
      await disposeParakeetModel()
    })

    test("concurrent starts share one in-flight model", async () => {
      await disposeParakeetModel()
      let resolveModel: ((model: MockParakeetModel) => void) | undefined
      let calls = 0
      const modelPromise = new Promise<MockParakeetModel>((resolve) => {
        resolveModel = resolve
      })
      const options = {
        keepWarm: true,
        fromHub: async () => {
          calls++
          return modelPromise
        },
        supportsLanguage: () => true,
        captureOptions: { mediaStream: { getTracks: () => [] } as unknown as MediaStream, isTypeSupported: () => true },
      }
      const first = createParakeetTranscriber(options)
      const firstStart = first.start()
      while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 0))
      const second = createParakeetTranscriber(options)
      const secondStart = second.start()
      const model = new MockParakeetModel("wasm")
      resolveModel?.(model)
      await Promise.all([Promise.resolve(firstStart), Promise.resolve(secondStart)])

      expect(calls).toBe(1)
      await first.stop()
      await second.stop()
      await disposeParakeetModel()
    })

    test("a waiter does not adopt a model disposed while it waits", async () => {
      await disposeParakeetModel()
      let resolveFirst: ((model: MockParakeetModel) => void) | undefined
      let calls = 0
      const first = new MockParakeetModel("wasm")
      const second = new MockParakeetModel("wasm")
      const firstModel = new Promise<MockParakeetModel>((resolve) => {
        resolveFirst = resolve
      })
      const fromHub = async () => {
        calls++
        return calls === 1 ? firstModel : second
      }
      const options = {
        keepWarm: true,
        fromHub,
        supportsLanguage: () => true,
        captureOptions: { mediaStream: { getTracks: () => [] } as unknown as MediaStream, isTypeSupported: () => true },
      }
      const firstTranscriber = createParakeetTranscriber(options)
      const firstStart = Promise.resolve(firstTranscriber.start())
      const firstFailure = firstStart.then(() => undefined, (error: unknown) => error)
      while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 0))

      const secondTranscriber = createParakeetTranscriber(options)
      const secondStart = secondTranscriber.start()
      const disposing = disposeParakeetModel()
      resolveFirst?.(first)
      await disposing
      const firstError = await firstFailure
      expect(firstError).toBeInstanceOf(Error)
      await secondStart

      expect(first.disposed).toBe(true)
      expect(second.disposed).toBe(false)
      await secondTranscriber.stop()
      await disposeParakeetModel()
    })

    test("warmupParakeetModel preloads model without starting microphone capture", async () => {
      await disposeParakeetModel()
      expect(isParakeetModelWarmedUp()).toBe(false)

      let fromHubCalls = 0
      const mockModel = new MockParakeetModel("wasm")
      const fakeFromHub = async () => {
        fromHubCalls++
        return mockModel
      }

      await warmupParakeetModel({
        onlyIfDownloaded: false,
        fromHub: fakeFromHub,
        supportsLanguage: () => true,
        captureOptions: {
          mediaStream: { getTracks: () => [] } as any,
          isTypeSupported: () => true,
        },
      })

      expect(fromHubCalls).toBe(1)
      expect(isParakeetModelWarmedUp()).toBe(true)

      // Transcriber starting after warmup starts instantly with zero fromHub calls
      const transcriber = createParakeetTranscriber({
        keepWarm: true,
        fromHub: fakeFromHub,
        supportsLanguage: () => true,
        captureOptions: {
          mediaStream: { getTracks: () => [] } as any,
          isTypeSupported: () => true,
        },
      })

      await transcriber.start()
      expect(fromHubCalls).toBe(1)
      await transcriber.stop()

      await disposeParakeetModel()
      expect(isParakeetModelWarmedUp()).toBe(false)
      expect(mockModel.disposed).toBe(true)
    })

    test("push-to-talk: startSegment, commit, and hasInFlight correctly finalize speech", async () => {
      const mockModel = new MockParakeetModel("wasm")
      const finals: any[] = []

      const capture = createMicCapture({
        mediaStream: {
          getTracks: () => [{ stop: () => {}, readyState: "live" }],
        } as any,
        isTypeSupported: () => true,
      })

      const transcriber = createParakeetTranscriber({
        capture,
        fromHub: async () => mockModel,
        supportsLanguage: () => true,
        onFinal: (evt) => finals.push(evt),
      })

      await transcriber.start()

      // Before speaking: no speech segment active
      expect(transcriber.hasInFlight).toBe(false)

      // Start PTT segment
      transcriber.startSegment()

      // Feed PCM audio chunk
      const frame = new Float32Array(1600)
      for (let i = 0; i < frame.length; i++) frame[i] = 0.1
      capture.processAudioFrame(frame, 16000)

      // Commit PTT segment
      const committed = transcriber.commit()
      expect(committed).toBe(true)

      // Wait for queue to drain
      await new Promise((r) => setTimeout(r, 60))

      expect(finals).toHaveLength(1)
      expect(finals[0].text).toBe("ciao mondo definitivo")
      expect(transcriber.hasInFlight).toBe(false)

      await transcriber.stop()
    })
  })
})

