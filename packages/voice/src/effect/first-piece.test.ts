import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { finishedUpTo, firstPieceUpTo, dispatchTranscription } from "./program"
import type { AdeView, PaneSummary, VoiceHost, VoiceStateSnapshot } from "../bridge/host"

describe("the first piece of a reply is said as soon as it can stand alone", () => {
  test("a finished sentence, as for every piece", () => {
    const text = "Parigi, ovviamente. E poi"
    expect(firstPieceUpTo(text)).toBe(finishedUpTo(text))
  })

  test("while the first sentence is written, its first clause long enough", () => {
    const text = "La capitale della Francia è Parigi, che ha"
    expect(text.slice(0, firstPieceUpTo(text))).toBe("La capitale della Francia è Parigi,")
  })

  test("not a short opening, a decimal, or a comma still at the end", () => {
    expect(firstPieceUpTo("Sì, certo, ")).toBe(0)
    expect(firstPieceUpTo("Il valore di pi greco è circa 3,14 e")).toBe(0)
    expect(firstPieceUpTo("La capitale della Francia è Parigi,")).toBe(0)
  })
})

/*
 * Rilievo 23: la dettatura senza un pannello a fuoco cadeva sul primo e,
 * in auto, premeva Invio lì. Con più sessioni aperte il testo partiva al
 * bersaglio sbagliato. Ora serve un bersaglio chiaro: il fuoco, oppure
 * l'unico pannello aperto.
 */
describe("dictation without a clear target asks instead of picking the first pane", () => {
  class DictationHost implements VoiceHost {
    calls: { method: string; args: any[] }[] = []
    panes: PaneSummary[] = [
      {
        id: "pane-1",
        title: "Bastelli",
        status: "idle" as any,
        index: 1,
        hasLiveProcess: false,
        isBrowser: false,
        isFile: false,
      },
      {
        id: "pane-2",
        title: "API Tests",
        status: "working" as any,
        index: 2,
        hasLiveProcess: true,
        isBrowser: false,
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
        workingSessions: 1,
        waitingSessions: 0,
        doneSessions: 1,
        errorSessions: 0,
        currentView: "agent",
        spokenSummary: "Ci sono 2 sessioni.",
      }
    }
  }

  test("with two open panels and no focus nothing is sent, auto or manual", async () => {
    for (const mode of ["auto", "manual"] as const) {
      const host = new DictationHost()
      const result = await Effect.runPromise(
        Effect.either(
          dispatchTranscription("aggiungi un test", host, mode, undefined)
        )
      )
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left.message).toContain("Non so su quale pannello")
      }
      expect(host.calls.some((c) => c.method === "sendPrompt")).toBe(false)
      expect(host.calls.some((c) => c.method === "insertText")).toBe(false)
    }
  })

  test("a focused panel is a clear target", async () => {
    const host = new DictationHost()
    await Effect.runPromise(dispatchTranscription("aggiungi un test", host, "manual", "pane-2"))
    expect(host.calls).toContainEqual({ method: "insertText", args: ["pane-2", "aggiungi un test"] })
  })

  test("a single open panel is a clear target", async () => {
    const host = new DictationHost()
    host.panes = [host.panes[0]!]
    await Effect.runPromise(dispatchTranscription("aggiungi un test", host, "auto", undefined))
    expect(host.calls).toContainEqual({ method: "sendPrompt", args: ["pane-1", "aggiungi un test"] })
  })
})
