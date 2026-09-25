import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { createFakeTranscriber } from "../asr/fake"
import { createFakeSpeaker } from "../tts/speaker"
import { DEFAULT_VOICE_SETTINGS } from "../settings/model"
import type { PaneSummary, VoiceHost, VoiceStateSnapshot } from "../bridge/host"
import { SpeakerFake, TranscriberFake, VoiceHostLive } from "./layers"
import { makeVoiceProgram } from "./program"

describe("a finished dictation is announced only once the host has taken it", () => {
  const SENT = "Dettatura completata e inviata all'agente."

  class DictationHost implements VoiceHost {
    calls: { method: string; args: unknown[] }[] = []
    panes: PaneSummary[] = [
      {
        id: "pane-1",
        title: "Worker",
        status: "working",
        index: 1,
        hasLiveProcess: true,
        isBrowser: false,
        isFile: false,
      },
    ]

    constructor(private readonly refusal?: Error) {}

    async runCommand(id: string): Promise<void> {
      this.calls.push({ method: "runCommand", args: [id] })
    }

    listPanes(): PaneSummary[] {
      return this.panes
    }

    focusPane(): void {}

    async sendPrompt(paneId: string, text: string): Promise<void> {
      this.calls.push({ method: "sendPrompt", args: [paneId, text] })
      if (this.refusal) throw this.refusal
    }

    async insertText(): Promise<void> {}

    async openFile(): Promise<void> {}

    async searchProject(): Promise<{ path: string; line?: number }[]> {
      return []
    }

    setPaneView(): void {}

    browserNavigate(): void {}

    answerPermission(): void {}

    setColumns(): void {}

    setView(): void {}

    scrollTranscript(): void {}

    describeState(): VoiceStateSnapshot {
      return {
        totalSessions: 1,
        workingSessions: 1,
        waitingSessions: 0,
        doneSessions: 0,
        errorSessions: 0,
        currentView: "code",
        spokenSummary: "C'è una sessione attiva.",
      }
    }
  }

  async function dictate(refusal?: Error) {
    const host = new DictationHost(refusal)
    const speaker = createFakeSpeaker()
    const visible: string[] = []
    const layer = Layer.mergeAll(
      TranscriberFake(createFakeTranscriber()),
      SpeakerFake(speaker),
      VoiceHostLive(host),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* makeVoiceProgram({
            getSettings: () => ({ ...DEFAULT_VOICE_SETTINGS, activation: "toggle" }),
            onError: (error) => visible.push(error),
          })
          yield* handle.submitText("inizia dettatura pannello 1")
          yield* handle.submitText("aggiungi un test")
          yield* handle.submitText("fine dettatura")
        }),
      ).pipe(Effect.provide(layer)),
    )

    return { spoken: speaker.spoken, visible, host }
  }

  test("a host that takes the text still hears the sentence it always heard", async () => {
    const { spoken, visible, host } = await dictate()

    expect(host.calls).toContainEqual({ method: "sendPrompt", args: ["pane-1", "aggiungi un test"] })
    expect(spoken).toContain(SENT)
    expect(visible).toHaveLength(0)
  })

  test("a host that refuses the send is not told the dictation went out", async () => {
    const { spoken, visible } = await dictate(new Error("Nessuna sessione attiva per il pannello 'pane-1'."))

    expect(spoken).not.toContain(SENT)
    expect(spoken).toContain("Non sono riuscito a inviare la dettatura: il testo non è partito.")
    expect(visible).toHaveLength(1)
    expect(visible[0]!.trim().length).toBeGreaterThan(0)
  })
})
