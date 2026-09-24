import { describe, expect, test } from "bun:test"
import type { PaneSummary, VoiceHost } from "../bridge/host"
import { createVoiceEngine } from "../engine"
import { createFakeTranscriber } from "../asr/fake"
import { createFakeSpeaker } from "../tts/speaker"

/*
 * V1-ter, reserve of ALTO 8: a stop with a confirmation open never told the
 * host, so the held message and the one in line behind it waited for ever,
 * and their `ade-msg` got no answer. The voice that stops refuses them.
 */

const pane = (id: string, index: number, title: string): PaneSummary => ({
  id, index, title, status: "idle", hasLiveProcess: true, isBrowser: false, isFile: false,
})

describe("a stop leaves no held message behind", () => {
  test("a stop with a confirmation open refuses what was asked and what waited", async () => {
    const decisions: [string, boolean][] = []
    const host = {
      async runCommand() {},
      listPanes: () => [pane("pA", 1, "Alfa")],
      focusPane() {},
      async sendPrompt() {},
      async insertText() {},
      async openFile() {},
      async searchProject() {
        return []
      },
      setPaneView() {},
      browserNavigate() {},
      answerPermission() {},
      setColumns() {},
      setView() {},
      scrollTranscript() {},
      confirmVoiceSend: (id: string, approved: boolean) => void decisions.push([id, approved]),
      describeState: () => ({
        totalSessions: 1, workingSessions: 0, waitingSessions: 0, doneSessions: 0, errorSessions: 0, currentView: "code", spokenSummary: "",
      }),
    } as unknown as VoiceHost
    const engine = createVoiceEngine({
      host,
      transcriber: createFakeTranscriber(),
      speaker: createFakeSpeaker(),
      now: () => 10_000,
      settings: { activation: "toggle", agentEngine: "auto" },
    })

    await engine.start()
    await engine.requestSendConfirmation("m1", "Alfa", "uno")
    await engine.requestSendConfirmation("m2", "Alfa", "due")
    expect(engine.status()).toBe("confirming")
    await engine.stop()

    expect(decisions).toEqual([["m1", false], ["m2", false]])
  })
})
