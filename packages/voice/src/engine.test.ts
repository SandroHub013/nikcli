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

  test("text typed with the microphone off still reaches the assistant, and opens no microphone", async () => {
    const { engine, host } = setupEngine()

    await engine.submitText("apri la tavolozza")
    await engine.submitText("apri la tavolozza")

    expect(host.calls.filter((call) => call.method === "runCommand")).toEqual([
      { method: "runCommand", args: ["palette.open"] },
      { method: "runCommand", args: ["palette.open"] },
    ])
    expect(engine.isRunning()).toBe(false)
    expect(engine.history().filter((entry) => entry.kind === "user")).toHaveLength(2)
  })

  describe("typed text with push-to-talk or a wake word", () => {
    function withActivation(activation: "push-to-talk" | "wake-word") {
      const host = new MockVoiceHost()
      const engine = createVoiceEngine({
        host,
        transcriber: createFakeTranscriber(),
        speaker: createFakeSpeaker(),
        now: () => 10_000,
        settings: { activation, mode: "agent" },
      })
      const opened = () => host.calls.filter((call) => call.method === "runCommand").length
      return { engine, opened }
    }

    test("push-to-talk: nothing is held, and the typed sentence still runs", async () => {
      const { engine, opened } = withActivation("push-to-talk")
      await engine.submitText("apri la tavolozza")
      expect(opened()).toBe(1)
    })

    test("wake word: the sentence runs without it, and a leading one is dropped", async () => {
      const { engine, opened } = withActivation("wake-word")
      await engine.submitText("apri la tavolozza")
      await engine.submitText("hei nik apri la tavolozza")
      expect(opened()).toBe(2)
    })

    test("once the microphone's session is up, typed text runs once, through it", async () => {
      const { engine, opened } = withActivation("wake-word")
      await engine.submitText("apri la tavolozza")
      await engine.start()
      await engine.submitText("apri la tavolozza")
      expect(opened()).toBe(2)
      await engine.stop()
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

  test("while a confirmation is pending, an unknown sentence is not handed to the agent", async () => {
    const { engine, host, transcriber, speaker } = setupEngine()
    let asked = 0
    ;(host as VoiceHost).askAgent = async () => {
      asked++
      return { ok: true, text: "fatto" }
    }
    await engine.start()
    transcriber.emit("chiudi pannello 1", true)
    await new Promise((r) => setTimeout(r, 10))
    transcriber.emit("raccontami una barzelletta", true)
    await new Promise((r) => setTimeout(r, 10))

    expect(asked).toBe(0)
    expect(engine.status()).toBe("confirming")
    expect(speaker.lastSpoken!.toLowerCase()).toContain("sì")
    await engine.stop()
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

describe("engine/stop delivers what was already heard", () => {
  function setup(drainTimeoutMs?: number) {
    const host = new MockVoiceHost()
    const transcriber = createFakeTranscriber()
    const engine = createVoiceEngine({
      host,
      transcriber,
      speaker: createFakeSpeaker(),
      now: () => 10_000,
      getContext: () => ({ focusedPaneId: "pane-1" }),
      ...(drainTimeoutMs === undefined ? {} : { drainTimeoutMs }),
    })
    return { host, transcriber, engine }
  }

  test("a sentence still in flight when dictation is closed reaches the pane", async () => {
    const { host, transcriber, engine } = setup()
    await engine.start("transcription")

    // The request for the last sentence has left; the user closes dictation.
    transcriber.setHasInFlight(true)
    const stopped = engine.stop()
    expect(engine.isRunning()).toBe(false)

    // The answer comes back after the press, as it does over the network.
    await new Promise((r) => setTimeout(r, 40))
    transcriber.emit("aggiungi un test", true)
    transcriber.setHasInFlight(false)
    await stopped

    expect(host.calls).toContainEqual({ method: "insertText", args: ["pane-1", "aggiungi un test"] })
    expect(transcriber.isStarted).toBe(false)
  })

  test("the drained sentence is still dictation, not a command", async () => {
    const { host, transcriber, engine } = setup()
    await engine.start("transcription")

    transcriber.setHasInFlight(true)
    const stopped = engine.stop()
    await new Promise((r) => setTimeout(r, 30))
    transcriber.emit("nuova sessione", true)
    transcriber.setHasInFlight(false)
    await stopped

    expect(host.calls.some((c) => c.method === "runCommand")).toBe(false)
    expect(host.calls).toContainEqual({ method: "insertText", args: ["pane-1", "nuova sessione"] })
  })

  test("a request that never returns does not hold the stop forever", async () => {
    const { transcriber, engine } = setup(100)
    await engine.start("transcription")

    transcriber.setHasInFlight(true)
    await engine.stop()

    expect(engine.isRunning()).toBe(false)
    expect(transcriber.isStarted).toBe(false)
  })

  test("a start pressed during the drain waits for it instead of racing it", async () => {
    const { transcriber, engine } = setup()
    await engine.start("transcription")

    transcriber.setHasInFlight(true)
    const stopped = engine.stop()
    const restarted = engine.start("transcription")
    await new Promise((r) => setTimeout(r, 30))
    transcriber.setHasInFlight(false)
    await stopped
    await restarted

    expect(engine.isRunning()).toBe(true)
    expect(engine.activeMode()).toBe("transcription")
    await engine.stop()
  })

  test("dictation with no pane open says so instead of doing nothing", async () => {
    const { host, transcriber, engine } = setup()
    host.panes = []
    await engine.start("transcription")

    transcriber.emit("aggiungi un test", true)
    await new Promise((r) => setTimeout(r, 10))

    expect(engine.lastError()).toContain("Nessun pannello aperto")
    await engine.stop()
  })
})

describe("engine/push-to-talk tap latches", () => {
  function setup() {
    let clock = 50_000
    const host = new MockVoiceHost()
    const transcriber = createFakeTranscriber()
    const engine = createVoiceEngine({
      host,
      transcriber,
      speaker: createFakeSpeaker(),
      now: () => clock,
      settings: { activation: "push-to-talk", mode: "transcription" },
      getContext: () => ({ focusedPaneId: "pane-1" }),
    })
    return { host, transcriber, engine, advance: (ms: number) => (clock += ms) }
  }

  test("a quick press leaves dictation on: no grace stop, and it survives a delivered sentence", async () => {
    const { host, transcriber, engine, advance } = setup()
    await engine.pressToTalk("transcription")
    advance(120)
    await engine.releaseToTalk()

    // Past the old 250 ms grace, which closed a tap that recorded nothing.
    await new Promise((r) => setTimeout(r, 300))
    expect(engine.isRunning()).toBe(true)

    transcriber.emit("prima frase", true)
    await new Promise((r) => setTimeout(r, 20))
    transcriber.emit("seconda frase", true)
    await new Promise((r) => setTimeout(r, 20))

    expect(host.calls.filter((c) => c.method === "insertText").map((c) => c.args[1])).toEqual([
      "prima frase",
      "seconda frase",
    ])
    expect(engine.isRunning()).toBe(true)
    await engine.stop()
  })

  test("the next press closes a latched session, and its release starts nothing", async () => {
    const { engine, advance } = setup()
    await engine.pressToTalk("transcription")
    advance(100)
    await engine.releaseToTalk()
    expect(engine.isRunning()).toBe(true)

    await engine.pressToTalk("transcription")
    expect(engine.isRunning()).toBe(false)
    advance(100)
    await engine.releaseToTalk()
    await new Promise((r) => setTimeout(r, 20))
    expect(engine.isRunning()).toBe(false)

    // And the one after that opens it again.
    await engine.pressToTalk("transcription")
    expect(engine.isRunning()).toBe(true)
    await engine.stop()
  })

  test("a hold is still push-to-talk: the sentence is delivered and the session ends", async () => {
    const { host, transcriber, engine, advance } = setup()
    await engine.pressToTalk("transcription")
    advance(2_000)
    await engine.releaseToTalk()

    transcriber.emit("detto tenendo premuto", true)
    await new Promise((r) => setTimeout(r, 40))

    expect(host.calls).toContainEqual({ method: "insertText", args: ["pane-1", "detto tenendo premuto"] })
    expect(engine.isRunning()).toBe(false)
  })
})

describe("engine/agent answers what the grammar does not know", () => {
  function setup(agentEngine: "auto" | "off", answer: { ok: boolean; text: string }) {
    const host = new MockVoiceHost()
    const asked: { text: string; engine: string }[] = []
    ;(host as VoiceHost).askAgent = async (request) => {
      asked.push({ text: request.text, engine: request.engine })
      return answer
    }
    const speaker = createFakeSpeaker()
    const engine = createVoiceEngine({
      host,
      transcriber: createFakeTranscriber(),
      speaker,
      now: () => 10_000,
      settings: { agentEngine },
    })
    return { host, asked, speaker, engine }
  }

  test("an unmatched sentence goes to the agent and its answer is spoken", async () => {
    const { asked, speaker, engine } = setup("auto", { ok: true, text: "Ho chiesto alla sessione due: ha finito." })
    await engine.start()
    await engine.submitText("chiedi alla sessione dei test se ha finito e dimmi cosa ha trovato")
    await new Promise((r) => setTimeout(r, 20))

    expect(asked).toEqual([{ text: "chiedi alla sessione dei test se ha finito e dimmi cosa ha trovato", engine: "auto" }])
    expect(speaker.lastSpoken).toBe("Ho chiesto alla sessione due: ha finito.")
    expect(engine.status()).toBe("idle")
    await engine.stop()
  })

  describe("a sentence while the agent is still thinking", () => {
    function busy() {
      const host = new MockVoiceHost()
      const asked: string[] = []
      let aborted = 0
      ;(host as VoiceHost).askAgent = (request) =>
        new Promise((resolve) => {
          asked.push(request.text)
          request.signal?.addEventListener("abort", () => {
            aborted++
            resolve({ ok: false, text: "" })
          })
        })
      const speaker = createFakeSpeaker()
      const engine = createVoiceEngine({ host, transcriber: createFakeTranscriber(), speaker, now: () => 10_000, settings: { agentEngine: "auto" } })
      return { host, asked, speaker, engine, aborted: () => aborted }
    }

    test("a known command is carried out instead of vanishing, and the turn is stopped", async () => {
      const { host, asked, engine, aborted } = busy()
      void engine.submitText("raccontami la storia di Roma in tre frasi")
      await new Promise((r) => setTimeout(r, 20))
      expect(engine.status()).toBe("executing")

      await engine.submitText("apri la tavolozza")
      await new Promise((r) => setTimeout(r, 20))

      expect(asked).toEqual(["raccontami la storia di Roma in tre frasi"])
      expect(aborted()).toBe(1)
      expect(host.calls).toContainEqual({ method: "runCommand", args: ["palette.open"] })
      expect(engine.status()).toBe("idle")
      expect(engine.history().some((entry) => entry.kind === "action" && entry.label.startsWith("Richiesta precedente interrotta"))).toBe(true)
    })

    test("«annulla» stops the turn and says so", async () => {
      const { host, engine, aborted } = busy()
      void engine.submitText("raccontami la storia di Roma in tre frasi")
      await new Promise((r) => setTimeout(r, 20))

      await engine.submitText("annulla")
      await new Promise((r) => setTimeout(r, 20))

      expect(aborted()).toBe(1)
      expect(engine.status()).toBe("idle")
      expect(engine.lastSpoken()).toBe("Ho fermato la richiesta precedente.")
      expect(host.calls.filter((call) => call.method === "runCommand")).toHaveLength(0)
    })
  })

  describe("heard while the agent is thinking: only a stop or a known command ends the turn", () => {
    async function thinking() {
      const host = new MockVoiceHost()
      const asked: string[] = []
      const answers: ((text: string) => void)[] = []
      let aborted = 0
      ;(host as VoiceHost).askAgent = (request) =>
        new Promise((resolve) => {
          asked.push(request.text)
          answers.push((text) => resolve({ ok: true, text, ran: true }))
          request.signal?.addEventListener("abort", () => {
            aborted++
            resolve({ ok: false, text: "", ran: true })
          })
        })
      const transcriber = createFakeTranscriber()
      const engine = createVoiceEngine({ host, transcriber, speaker: createFakeSpeaker(), now: () => 10_000, settings: { agentEngine: "auto" } })
      await engine.start()
      transcriber.emit("raccontami la storia di Roma in tre frasi", true)
      await new Promise((r) => setTimeout(r, 20))
      expect(engine.status()).toBe("executing")
      const hear = async (text: string) => {
        transcriber.emit(text, true)
        await new Promise((r) => setTimeout(r, 20))
      }
      const answer = async (text: string) => {
        answers.shift()!(text)
        await new Promise((r) => setTimeout(r, 20))
      }
      return { host, asked, engine, hear, answer, aborted: () => aborted }
    }

    const TV = "il governo ha approvato la legge di bilancio nella notte"

    test("a long free sentence from the room does not stop the turn: it is held and shown, and fillers are left alone", async () => {
      const { asked, engine, hear, answer, aborted } = await thinking()
      await hear("ok")
      await hear(TV)

      expect(aborted()).toBe(0)
      expect(engine.status()).toBe("executing")
      expect(engine.held()).toBe(TV)
      expect(engine.history().some((entry) => entry.kind === "action" && entry.label.startsWith(`Sentito mentre pensavo: «${TV}»`))).toBe(true)

      // Not confirmed: the turn answers and the held sentence is never asked.
      await answer("Roma fu fondata nel 753 a.C.")
      expect(asked).toEqual(["raccontami la storia di Roma in tre frasi"])
      expect(engine.lastSpoken()).toBe("Roma fu fondata nel 753 a.C.")
      await engine.stop()
    })

    test("«invia questa» during the turn sends the held sentence once the turn is over", async () => {
      const { asked, engine, hear, answer, aborted } = await thinking()
      await hear(TV)
      await hear("invia questa")
      expect(aborted()).toBe(0)
      expect(asked).toHaveLength(1)

      await answer("Fatto.")
      expect(asked).toEqual(["raccontami la storia di Roma in tre frasi", TV])
      expect(engine.held()).toBeNull()
      await engine.stop()
    })

    test("«invia questa» after the turn, as the console's button does, sends it at once", async () => {
      const { asked, engine, hear, answer } = await thinking()
      await hear(TV)
      await answer("Fatto.")
      expect(engine.held()).toBe(TV)

      void engine.submitText("invia questa")
      await new Promise((r) => setTimeout(r, 20))
      expect(asked).toEqual(["raccontami la storia di Roma in tre frasi", TV])
      await engine.stop()
    })

    test("another sentence drops the held one", async () => {
      const { asked, engine, hear, answer } = await thinking()
      await hear(TV)
      await answer("Fatto.")
      await engine.submitText("apri la tavolozza")
      await new Promise((r) => setTimeout(r, 20))
      expect(engine.held()).toBeNull()
      await engine.submitText("invia questa")
      await new Promise((r) => setTimeout(r, 20))
      expect(asked).not.toContain(TV)
      await engine.stop()
    })

    test("closing the microphone mid-turn stops the turn instead of waiting for it", async () => {
      const { engine, aborted } = await thinking()
      const started = Date.now()
      await engine.stop()
      expect(aborted()).toBe(1)
      expect(Date.now() - started).toBeLessThan(1000)
    })

    test("«annulla» said aloud stops the turn at once, not after the answer", async () => {
      const { host, engine, hear, aborted } = await thinking()
      await hear("annulla")

      expect(aborted()).toBe(1)
      expect(engine.status()).toBe("idle")
      expect(engine.lastSpoken()).toBe("Ho fermato la richiesta precedente.")
      expect(host.calls.filter((call) => call.method === "runCommand")).toHaveLength(0)
      await engine.stop()
    })

    test("a real request stops the turn and is carried out", async () => {
      const { host, engine, hear, aborted } = await thinking()
      await hear("apri la tavolozza")

      expect(aborted()).toBe(1)
      expect(host.calls).toContainEqual({ method: "runCommand", args: ["palette.open"] })
      await engine.stop()
    })
  })

  test("a known command never reaches the agent", async () => {
    const { host, asked, engine } = setup("auto", { ok: true, text: "no" })
    await engine.start()
    await engine.submitText("nuova sessione")
    await new Promise((r) => setTimeout(r, 20))

    expect(asked).toHaveLength(0)
    expect(host.calls).toContainEqual({ method: "runCommand", args: ["session.new"] })
    await engine.stop()
  })

  test("with the agent off, an unmatched sentence is not handed over", async () => {
    const { asked, engine } = setup("off", { ok: true, text: "no" })
    await engine.start()
    await engine.submitText("chiedi alla sessione dei test se ha finito")
    await new Promise((r) => setTimeout(r, 20))

    expect(asked).toHaveLength(0)
    await engine.stop()
  })

  test("a failed turn is shown as an error and said", async () => {
    const { speaker, engine } = setup("auto", { ok: false, text: "claude non si avvia" })
    await engine.start()
    await engine.submitText("chiedi alla sessione dei test se ha finito")
    await new Promise((r) => setTimeout(r, 20))

    expect(engine.lastError()).toBe("claude non si avvia")
    expect(speaker.lastSpoken).toBe("claude non si avvia")
    await engine.stop()
  })
})
