import { describe, expect, test } from "bun:test"
import { createVoiceEngine } from "./engine"
import { createFakeTranscriber } from "./asr/fake"
import { createFakeSpeaker } from "./tts/speaker"
import { VOCABULARY } from "./intent/vocabulary"
import type { AdeView, PaneSummary, VoiceHost, VoiceStateSnapshot } from "./bridge/host"

class MockVoiceHost implements VoiceHost {
  calls: { method: string; args: any[] }[] = []
  panes: PaneSummary[] = [
    {
      id: "pane-1",
      title: "Worker Process",
      status: "working",
      index: 1,
      hasLiveProcess: true,
      isBrowser: false,
      isFile: false,
    },
    {
      id: "pane-2",
      title: "Preview",
      status: "done",
      index: 2,
      hasLiveProcess: false,
      isBrowser: true,
      isFile: false,
    },
  ]

  async runCommand(id: string): Promise<void> {
    this.calls.push({ method: "runCommand", args: [id] })
  }

  listPanes(): PaneSummary[] {
    return this.panes
  }

  focusPane(paneId: string): void {
    this.calls.push({ method: "focusPane", args: [paneId] })
  }

  async sendPrompt(paneId: string, text: string): Promise<void> {
    this.calls.push({ method: "sendPrompt", args: [paneId, text] })
  }

  async insertText(paneId: string, text: string): Promise<void> {
    this.calls.push({ method: "insertText", args: [paneId, text] })
  }

  async openFile(path: string): Promise<void> {
    this.calls.push({ method: "openFile", args: [path] })
  }

  async searchProject(query: string): Promise<{ path: string; line?: number }[]> {
    this.calls.push({ method: "searchProject", args: [query] })
    return []
  }

  setPaneView(paneId: string, view: "transcript" | "diff"): void {
    this.calls.push({ method: "setPaneView", args: [paneId, view] })
  }

  browserNavigate(paneId: string, url: string): void {
    this.calls.push({ method: "browserNavigate", args: [paneId, url] })
  }

  answerPermission(paneId: string, answer: "allow" | "deny"): void {
    this.calls.push({ method: "answerPermission", args: [paneId, answer] })
  }

  setColumns(columns?: number): void {
    this.calls.push({ method: "setColumns", args: [columns] })
  }

  setView(view: AdeView): void {
    this.calls.push({ method: "setView", args: [view] })
  }

  scrollTranscript(paneId: string, delta: number): void {
    this.calls.push({ method: "scrollTranscript", args: [paneId, delta] })
  }

  describeState(): VoiceStateSnapshot {
    return {
      totalSessions: 2,
      workingSessions: 1,
      waitingSessions: 0,
      doneSessions: 1,
      errorSessions: 0,
      currentView: "code",
      spokenSummary: "ADE ha 2 sessioni attive.",
    }
  }
}

describe("engine/createVoiceEngine", () => {
  function setupEngine(initialTime = 10_000) {
    let currentTime = initialTime
    const host = new MockVoiceHost()
    const transcriber = createFakeTranscriber()
    const speaker = createFakeSpeaker()

    const engine = createVoiceEngine({
      host,
      transcriber,
      speaker,
      now: () => currentTime,
    })

    return {
      engine,
      host,
      transcriber,
      speaker,
      advanceTime: (ms: number) => {
        currentTime += ms
      },
    }
  }

  test("full cycle: spoken phrase dispatches to VoiceHost cleanly without preset offline readback", async () => {
    const { engine, host, transcriber, speaker } = setupEngine()

    await engine.start()
    expect(engine.isRunning()).toBe(true)
    expect(engine.status()).toBe("idle")

    // User speaks non-destructive command "nuova sessione"
    transcriber.emit("nuova sessione", true)

    // Allow async dispatch execution
    await new Promise((r) => setTimeout(r, 10))

    // Host should receive runCommand("session.new")
    expect(host.calls).toContainEqual({
      method: "runCommand",
      args: ["session.new"],
    })

    // Preset readbacks are removed: speaker must not speak canned offline phrase
    expect(speaker.spoken).not.toContain("Creo una nuova sessione")

    // Outcome and status should reflect completion
    expect(engine.lastOutcome()?.success).toBe(true)
    expect(engine.status()).toBe("idle")
  })

  test("submitText allows keyboard or accessibility invocation", async () => {
    const { engine, host } = setupEngine()

    await engine.start()
    await engine.submitText("apri la tavolozza")

    expect(host.calls).toContainEqual({
      method: "runCommand",
      args: ["palette.open"],
    })
  })

  /*
   * Starting is not instant. With the local backend it means downloading and
   * initialising a model — minutes, not milliseconds — and `isRunning()` was
   * only written at the end of it. Everything below happens inside that
   * window, and each case used to leave a microphone open that nothing could
   * close: two presses built two sessions and the first became unreachable; a
   * stop closed scopes that were still null and the session that landed
   * afterwards kept recording behind an interface saying it was off.
   */
  describe("avvio lento", () => {
    /** A transcriber whose `start()` resolves only when the test says so. */
    function slowTranscriber() {
      let release: (() => void) | undefined
      let starts = 0
      let stops = 0
      return {
        get starts() {
          return starts
        },
        get stops() {
          return stops
        },
        finish: () => release?.(),
        transcriber: {
          start: () => {
            starts += 1
            return new Promise<void>((resolve) => {
              release = resolve
            })
          },
          stop: () => {
            stops += 1
          },
          onPartial: () => {},
          onFinal: () => {},
          onError: () => {},
        },
      }
    }

    test("due pressioni ravvicinate aprono una sessione sola", async () => {
      const slow = slowTranscriber()
      const engine = createVoiceEngine({
        host: new MockVoiceHost(),
        transcriber: slow.transcriber,
        speaker: createFakeSpeaker(),
        now: () => 10_000,
      })

      const first = engine.start()
      const second = engine.start()
      slow.finish()
      await Promise.all([first, second])

      expect(slow.starts).toBe(1)
      expect(engine.isRunning()).toBe(true)
    })

    test("fermare durante l'avvio non lascia il microfono aperto", async () => {
      const slow = slowTranscriber()
      const engine = createVoiceEngine({
        host: new MockVoiceHost(),
        transcriber: slow.transcriber,
        speaker: createFakeSpeaker(),
        now: () => 10_000,
      })

      const starting = engine.start()
      await engine.stop()
      slow.finish()
      await starting

      // The session that landed after the stop was freed rather than
      // installed: not running, and the transcriber was told to let go.
      expect(engine.isRunning()).toBe(false)
      expect(slow.stops).toBeGreaterThanOrEqual(1)
    })
  })

  test("destructive command requires explicit confirmation before executing", async () => {
    const { engine, host, transcriber, speaker } = setupEngine()

    await engine.start()

    // "chiudi pannello" is a destructive intent
    transcriber.emit("chiudi pannello 1", true)
    await new Promise((r) => setTimeout(r, 10))

    // MUST NOT have executed yet
    expect(host.calls.filter((c) => c.method === "runCommand")).toHaveLength(0)

    // Engine must be in confirming state asking the user
    expect(engine.status()).toBe("confirming")
    // The prompt must read as a question about this specific action, and must
    // say how to answer. Asserting the behaviour, not one exact sentence.
    expect(speaker.lastSpoken).toContain("chiudere il pannello")
    expect(speaker.lastSpoken).toContain("?")
    expect(speaker.lastSpoken!.toLowerCase()).toContain("sì o no")

    // User confirms with "conferma"
    transcriber.emit("conferma", true)
    await new Promise((r) => setTimeout(r, 10))

    // NOW the destructive command has executed
    expect(host.calls).toContainEqual({
      method: "runCommand",
      args: ["pane.close"],
    })
    expect(engine.status()).toBe("idle")
  })

  test("canceling destructive confirmation does not execute command", async () => {
    const { engine, host, transcriber, speaker } = setupEngine()

    await engine.start()

    // Trigger destructive intent
    transcriber.emit("termina processo", true)
    await new Promise((r) => setTimeout(r, 10))

    expect(engine.status()).toBe("confirming")
    expect(host.calls.filter((c) => c.method === "runCommand")).toHaveLength(0)

    // User cancels
    transcriber.emit("annulla", true)
    await new Promise((r) => setTimeout(r, 10))

    // Must still NOT have executed
    expect(host.calls.filter((c) => c.method === "runCommand")).toHaveLength(0)
    expect(speaker.lastSpoken).toBe("Operazione annullata.")
    expect(engine.status()).toBe("idle")
  })

  test("ambiguous utterance does not execute and queries user for clarification", async () => {
    const { engine, host, transcriber, speaker } = setupEngine()

    await engine.start()

    // An utterance that really is ambiguous: "vai al" is the shared opening of
    // "vai al pannello" (pane.focus) and "vai al sito" (browser.navigate), and
    // nothing after it says which. Both score identically.
    transcriber.emit("vai al", true)
    await new Promise((r) => setTimeout(r, 10))

    // Nothing must be executed on the host
    expect(host.calls).toHaveLength(0)

    // Speaker should ask clarification question
    expect(speaker.lastSpoken).toContain("Comando ambiguo")

    // User chooses first option with "la prima"
    transcriber.emit("la prima", true)
    await new Promise((r) => setTimeout(r, 10))

    // Now one command was executed
    expect(host.calls.length).toBeGreaterThan(0)
  })

  test("unknown utterance does not speak offline fallback suggestions", async () => {
    const { engine, host, transcriber, speaker } = setupEngine()

    await engine.start()

    // Completely unrecognized phrase
    transcriber.emit("vola sulla luna con un razzo", true)
    await new Promise((r) => setTimeout(r, 10))

    // Zero host calls
    expect(host.calls).toHaveLength(0)

    // Offline fallback prompt is removed: speaker stays silent
    expect(speaker.spoken).toHaveLength(0)
    expect(engine.lastError()).toBeDefined()
  })

  test("recognition error does not lock the engine into an unrecoverable state", async () => {
    const { engine, host, transcriber } = setupEngine()

    await engine.start()
    expect(engine.status()).toBe("idle")

    // Transcriber reports hardware / device error
    transcriber.emitError(new Error("Dispositivo microfono disconnesso"))

    // Error is captured in signal
    expect(engine.lastError()).toBe("Dispositivo microfono disconnesso")
    expect(engine.status()).toBe("idle")

    // Subsequent normal input works fine without needing a restart
    await engine.submitText("nuova sessione")
    expect(host.calls).toContainEqual({
      method: "runCommand",
      args: ["session.new"],
    })
  })

  test("handles pending permission request with priority", async () => {
    const { engine, host, transcriber } = setupEngine()

    await engine.start()

    // Host alerts engine that pane-1 needs permission
    await engine.handlePermissionRequest("pane-1", "esecuzione di npm install")

    expect(engine.status()).toBe("confirming")
    expect(engine.dialogState().pendingAction?.isPermission).toBe(true)

    // User grants permission
    transcriber.emit("consenti", true)
    await new Promise((r) => setTimeout(r, 10))

    expect(host.calls).toContainEqual({
      method: "answerPermission",
      args: ["pane-1", "allow"],
    })
    expect(engine.status()).toBe("idle")
  })

  test("transcription mode never speaks: silently inserts transcribed text into pane", async () => {
    const { engine, host, transcriber, speaker } = setupEngine()

    // Start specifically in transcription mode
    await engine.start("transcription")
    expect(engine.isRunning()).toBe(true)

    // User speaks arbitrary text to transcribe
    transcriber.emit("questo è un testo dettato per il composer", true)

    // Allow async dispatch execution
    await new Promise((r) => setTimeout(r, 20))

    // Host must have received insertText
    expect(host.calls).toContainEqual({
      method: "insertText",
      args: ["pane-1", "questo è un testo dettato per il composer"],
    })

    // Speaker MUST be completely silent: zero words spoken
    expect(speaker.spoken.length).toBe(0)
    expect(speaker.lastSpoken).toBeUndefined()
    expect(engine.dictated()).toContain("questo è un testo dettato per il composer")
  })

  test("entering transcription mode cancels any ongoing speech and remains silent on error", async () => {
    const { engine, host, transcriber, speaker } = setupEngine()

    // Simulate speaker talking
    await speaker.speak("Sto parlando di una risposta lunga...")
    expect(speaker.lastSpoken).toBe("Sto parlando di una risposta lunga...")

    // Switching/pressing transcription mode cancels TTS immediately
    let cancelled = false
    const origCancel = speaker.cancel
    speaker.cancel = () => {
      cancelled = true
      origCancel.call(speaker)
    }

    await engine.pressToTalk("transcription")
    expect(cancelled).toBe(true)

    // Simulate ASR error while in transcription mode
    transcriber.emitError(new Error("Network timeout on transcription backend"))
    await new Promise((r) => setTimeout(r, 20))

    // Error is reported to engine state, but speaker must NOT speak the error
    expect(engine.lastError()).toBeDefined()
    // Still only the old message from before transcription, no new speech added
    expect(speaker.spoken.length).toBe(1)
    expect(speaker.lastSpoken).toBe("Sto parlando di una risposta lunga...")
  })
})
