import { describe, expect, test } from "bun:test"
import { createTranscriberFor, describeBackends, type SelectTranscriberOptions } from "./select"
import { createVoiceEngine } from "../engine"
import { createFakeSpeaker } from "../tts/speaker"
import type { VoiceHost, PaneSummary } from "../bridge/host"

class SimpleHost implements VoiceHost {
  panes: PaneSummary[] = []
  async runCommand(): Promise<void> {}
  listPanes(): PaneSummary[] {
    return this.panes
  }
  focusPane(): void {}
  async sendPrompt(): Promise<void> {}
  async insertText(): Promise<void> {}
  async openFile(): Promise<void> {}
  async searchProject(): Promise<any[]> {
    return []
  }
  setPaneView(): void {}
  browserNavigate(): void {}
  reloadBrowser(): void {}
  clickBrowserCoordinate(): void {}
  pressBrowserKey(): void {}
  answerPermission(): void {}
  setColumns(): void {}
  setView(): void {}
  scrollTranscript(): void {}
  describeState(): any {
    return {
      totalSessions: 0,
      workingSessions: 0,
      waitingSessions: 0,
      doneSessions: 0,
      errorSessions: 0,
      currentView: "code",
      spokenSummary: "",
    }
  }
}

describe("asr/select", () => {
  test("describeBackends reports the localized reason when the engine is unavailable", () => {
    // The test runner has no OpenRouter key configured
    const status = describeBackends({})

    // Both backends, both without the key their fallback needs
    expect(Object.keys(status)).toEqual(["openrouter", "grokStream"])
    expect(status.openrouter.usable).toBe(false)
    expect(status.openrouter.reason).toContain("Chiave API OpenRouter mancante")
    expect(status.grokStream.usable).toBe(false)
    expect(status.grokStream.reason).toContain("Chiave API OpenRouter mancante")
  })

  test("describeBackends reports usable when requirements are met", () => {
    const status = describeBackends({
      apiKey: "sk-or-valid-test-key",
    })

    expect(status.openrouter.usable).toBe(true)
    expect(status.grokStream.usable).toBe(true)
  })

  test("describeBackends NEVER throws an exception even under malformed input", () => {
    expect(() => describeBackends(null as any)).not.toThrow()
    expect(() => describeBackends(undefined)).not.toThrow()
    expect(() => describeBackends({ openRouterOptions: null as any })).not.toThrow()

    const res = describeBackends(null as any)
    expect(res).toBeDefined()
    expect(res.openrouter).toBeDefined()
  })

  test("createTranscriberFor instantiates the requested backend or throws clean error for unknown", () => {
    // OpenRouter
    const openrouter = createTranscriberFor("openrouter", {
      apiKey: "test-key",
      openRouterOptions: {
        captureOptions: {
          mediaStream: { getTracks: () => [] } as any,
          isTypeSupported: () => true,
        },
      },
    })
    expect(openrouter).toBeDefined()
    expect(typeof openrouter.start).toBe("function")

    // Unknown backend
    expect(() => createTranscriberFor("invalid-engine" as any)).toThrow(/Backend di trascrizione non riconosciuto/i)
  })

  test("createTranscriberFor builds the streaming backend over an injected transport", () => {
    const transcriber = createTranscriberFor("grok-stream", {
      apiKey: "test-key",
      grokStreamOptions: {
        transport: {
          open: async () => {},
          send: async () => {},
          end: async () => {},
          cancel: () => {},
        },
        keyterms: ["nik"],
      },
      openRouterOptions: {
        captureOptions: {
          mediaStream: { getTracks: () => [] } as any,
          isTypeSupported: () => true,
        },
      },
    })
    expect(transcriber).toBeDefined()
    expect(typeof transcriber.start).toBe("function")
    expect(typeof transcriber.finish).toBe("function")
  })

  test("the streaming backend refuses to be built without its transport", () => {
    expect(() => createTranscriberFor("grok-stream", { apiKey: "test-key" })).toThrow(/transport/i)
  })

  test("createVoiceEngine automatically constructs transcriber when backend option is provided", () => {
    const host = new SimpleHost()
    const speaker = createFakeSpeaker()

    const engine = createVoiceEngine({
      host,
      speaker,
      now: () => 1000,
      backend: "openrouter",
      backendOptions: {
        apiKey: "test-key",
        openRouterOptions: {
          captureOptions: {
            mediaStream: { getTracks: () => [] } as any,
            isTypeSupported: () => true,
          },
        },
      },
      settings: { activation: "toggle" },
    })

    expect(engine).toBeDefined()
    expect(engine.status()).toBe("idle")
    expect(typeof engine.start).toBe("function")
  })
})
