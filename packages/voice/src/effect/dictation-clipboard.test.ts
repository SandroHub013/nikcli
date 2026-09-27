import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer } from "effect"

import { createFakeTranscriber } from "../asr/fake"
import { createFakeSpeaker } from "../tts/speaker"
import { DEFAULT_VOICE_SETTINGS } from "../settings/model"
import type { PaneSummary, VoiceHost, VoiceStateSnapshot } from "../bridge/host"
import { writeClipboard } from "../engine"
import { SpeakerFake, TranscriberFake, VoiceHostLive } from "./layers"
import { DICTATION_IN_CLIPBOARD, makeVoiceProgram } from "./program"

/*
 * Verdict of area 3, A4: every dictated sentence was written to the clipboard,
 * twice (the host's write and the webview's), whether it reached the pane or
 * not, and nothing said so. Now: once, only when it did not land, and the line
 * on screen says where the text is.
 */
class DictationHost implements VoiceHost {
  inserted: string[] = []
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

  listPanes(): PaneSummary[] {
    return this.panes
  }

  async insertText(_paneId: string, text: string): Promise<void> {
    if (this.refusal) throw this.refusal
    this.inserted.push(text)
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

async function dictate(host: DictationHost, kept: boolean) {
  const clipboard: string[] = []
  const visible: string[] = []
  const layer = Layer.mergeAll(
    TranscriberFake(createFakeTranscriber()),
    SpeakerFake(createFakeSpeaker()),
    VoiceHostLive(host),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* makeVoiceProgram({
          getSettings: () => ({ ...DEFAULT_VOICE_SETTINGS, activation: "toggle", mode: "transcription" }),
          getContext: () => ({ focusedPaneId: "pane-1" }),
          onUndelivered: (text) => {
            clipboard.push(text)
            return kept
          },
          onError: (error) => visible.push(error),
        })
        yield* handle.submitText("aggiungi un test")
      }),
    ).pipe(Effect.provide(layer)),
  )
  return { clipboard, visible }
}

describe("a dictated sentence and the clipboard", () => {
  test("a sentence the pane takes leaves the clipboard alone", async () => {
    const host = new DictationHost()
    const { clipboard, visible } = await dictate(host, true)
    expect(host.inserted).toEqual(["aggiungi un test"])
    expect(clipboard).toEqual([])
    expect(visible).toEqual([])
  })

  test("a sentence the pane refuses goes to the clipboard once, and the line says so", async () => {
    const { clipboard, visible } = await dictate(
      new DictationHost(new Error("Il pannello non ha un processo in ascolto.")),
      true,
    )
    expect(clipboard).toEqual(["aggiungi un test"])
    expect(visible).toHaveLength(1)
    expect(visible[0]).toContain("Il pannello non ha un processo in ascolto.")
    expect(visible[0]!.endsWith(DICTATION_IN_CLIPBOARD)).toBe(true)
  })

  test("with no pane open the text is kept, and said to be, once", async () => {
    const host = new DictationHost()
    host.panes = []
    const { clipboard, visible } = await dictate(host, true)
    expect(clipboard).toEqual(["aggiungi un test"])
    expect(visible).toEqual([`Nessun pannello aperto. ${DICTATION_IN_CLIPBOARD}`])
  })

  test("where nothing could keep it, the line does not claim the clipboard has it", async () => {
    const host = new DictationHost()
    host.panes = []
    const { visible } = await dictate(host, false)
    expect(visible).toEqual(["Nessun pannello aperto."])
  })
})

describe("the clipboard write", () => {
  test("goes through the host, once, with the text", () => {
    const calls: [string, Record<string, unknown> | undefined][] = []
    const win = {
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string, args?: Record<string, unknown>) => void calls.push([cmd, args]),
      },
    }
    expect(writeClipboard("ciao", win)).toBe(true)
    expect(calls).toEqual([["write_clipboard", { text: "ciao" }]])
  })

  test("without a host it writes nothing and says so", () => {
    expect(writeClipboard("ciao", {})).toBe(false)
    expect(writeClipboard("ciao", undefined)).toBe(false)
  })

  test("lint: the engine writes the clipboard only for an undelivered sentence, never through the webview", () => {
    const engine = readFileSync(join(import.meta.dir, "..", "engine.ts"), "utf8")
    expect(engine.includes("navigator.clipboard")).toBe(false)
    const start = engine.indexOf("onTranscribed: (text) => {")
    expect(start).toBeGreaterThan(-1)
    const transcribed = engine.slice(start, engine.indexOf("\n    },", start))
    expect(transcribed.includes("clipboard")).toBe(false)
    expect(engine.includes("onUndelivered: (text) => writeClipboard(text),")).toBe(true)
  })
})
