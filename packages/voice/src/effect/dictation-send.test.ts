import { describe, expect, test } from "bun:test"
import { Duration, Effect, Layer } from "effect"

import { createFakeTranscriber, type FakeTranscriber } from "../asr/fake"
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
    const layer = Layer.mergeAll(TranscriberFake(createFakeTranscriber()), SpeakerFake(speaker), VoiceHostLive(host))

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

describe("a dictated sentence goes to the pane it was spoken to", () => {
  class TwoPaneHost implements VoiceHost {
    calls: { method: string; args: unknown[] }[] = []
    panes: PaneSummary[] = [
      {
        id: "pane-1",
        title: "Primo",
        status: "working",
        index: 1,
        hasLiveProcess: true,
        isBrowser: false,
        isFile: false,
      },
      {
        id: "pane-2",
        title: "Secondo",
        status: "working",
        index: 2,
        hasLiveProcess: true,
        isBrowser: false,
        isFile: false,
      },
    ]

    listPanes(): PaneSummary[] {
      return this.panes
    }

    async insertText(paneId: string, text: string): Promise<void> {
      this.calls.push({ method: "insertText", args: [paneId, text] })
    }

    focusPane(): void {}
    async runCommand(): Promise<void> {}
    async sendPrompt(): Promise<void> {}
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
        totalSessions: 2,
        workingSessions: 2,
        waitingSessions: 0,
        doneSessions: 0,
        errorSessions: 0,
        currentView: "code",
        spokenSummary: "Due sessioni attive.",
      }
    }
  }

  /**
   * `focus` is read by the program as many times as it likes: the test moves
   * it while the sentence is being spoken, which is the whole point. A step is
   * something the recogniser says — the last one of a sentence is its final —
   * or `"elsewhere"`, which puts the eyes on the other pane.
   */
  async function speakWhileTheFocusMoves(
    transcriber: FakeTranscriber,
    focus: { paneId: string },
    steps: (string | "elsewhere")[],
  ) {
    const host = new TwoPaneHost()
    const layer = Layer.mergeAll(TranscriberFake(transcriber), SpeakerFake(createFakeSpeaker()), VoiceHostLive(host))

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* makeVoiceProgram({
            getSettings: () => ({ ...DEFAULT_VOICE_SETTINGS, activation: "toggle", mode: "transcription" }),
            getContext: () => ({ focusedPaneId: focus.paneId }),
            onError: () => {},
          })
          // The last thing said is the one that ends the sentence.
          const last = steps.reduce((spoken, step, at) => (step === "elsewhere" ? spoken : at), -1)
          for (const [at, step] of steps.entries()) {
            if (step === "elsewhere") {
              focus.paneId = "pane-2"
              yield* Effect.sleep(Duration.millis(10))
              continue
            }
            // The user starts talking with the first pane in front of them.
            transcriber.emit(step, at === last)
            yield* Effect.sleep(Duration.millis(at === last ? 30 : 10))
          }
        }),
      ).pipe(Effect.provide(layer)),
    )

    return host
  }

  test("la frase va al pannello che era a fuoco quando è iniziata, non a quello di dopo", async () => {
    const transcriber = createFakeTranscriber()
    // And the mouse is reached for before the sentence is finished.
    const host = await speakWhileTheFocusMoves(transcriber, { paneId: "pane-1" }, [
      "aggiungi un",
      "elsewhere",
      "aggiungi un test",
    ])

    expect(host.calls).toContainEqual({ method: "insertText", args: ["pane-1", "aggiungi un test"] })
    expect(host.calls).not.toContainEqual({ method: "insertText", args: ["pane-2", "aggiungi un test"] })
  })

  test("con due partial la frase va al pannello del primo, non a quello in cui è finita", async () => {
    const transcriber = createFakeTranscriber()
    // The eyes move in the middle of the sentence, and stay there: the partial
    // that follows is the same sentence still being spoken, not a new one.
    const host = await speakWhileTheFocusMoves(transcriber, { paneId: "pane-1" }, [
      "aggiungi un",
      "elsewhere",
      "aggiungi un test",
      "aggiungi un test del tutto",
    ])

    expect(host.calls).toContainEqual({ method: "insertText", args: ["pane-1", "aggiungi un test del tutto"] })
    expect(host.calls).not.toContainEqual({ method: "insertText", args: ["pane-2", "aggiungi un test del tutto"] })
  })

  test("una frase senza inizio riconosciuto va al pannello a fuoco in quel momento", async () => {
    const transcriber = createFakeTranscriber()
    const host = new TwoPaneHost()
    const layer = Layer.mergeAll(TranscriberFake(transcriber), SpeakerFake(createFakeSpeaker()), VoiceHostLive(host))

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* makeVoiceProgram({
            getSettings: () => ({ ...DEFAULT_VOICE_SETTINGS, activation: "toggle", mode: "transcription" }),
            getContext: () => ({ focusedPaneId: "pane-2" }),
            onError: () => {},
          })
          // Push-to-talk can hand over the whole sentence with no partial.
          transcriber.emit("aggiungi un test", true)
          yield* Effect.sleep(Duration.millis(30))
        }),
      ).pipe(Effect.provide(layer)),
    )

    expect(host.calls).toContainEqual({ method: "insertText", args: ["pane-2", "aggiungi un test"] })
  })
})
