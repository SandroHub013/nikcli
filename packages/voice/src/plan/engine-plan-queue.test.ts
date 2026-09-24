import { describe, expect, test } from "bun:test"
import { createVoiceEngine } from "../engine"
import { createFakeTranscriber } from "../asr/fake"
import { createFakeSpeaker } from "../tts/speaker"
import type { PaneSummary, VoiceHost, VoiceStateSnapshot } from "../bridge/host"

/*
 * V1-ter, ALTO 7: the plan's question wrote the dialogue state directly. A
 * held message that arrived while the planner was thinking was covered: the
 * yes said to the plan approved the message, and the plan stayed behind, to
 * be run by the yes to the next question («chiudi il pannello») instead of
 * what that yes was for. The plan's question now goes through the dialogue,
 * and waits in line when something is already being asked.
 */

const pane: PaneSummary = {
  id: "p1",
  title: "Uno",
  status: "working",
  index: 1,
  hasLiveProcess: true,
  isBrowser: false,
  isFile: false,
}

class Host implements VoiceHost {
  sent: { paneId: string; text: string }[] = []
  decisions: [string, boolean][] = []
  commands: string[] = []
  async runCommand(command: string): Promise<void> {
    this.commands.push(command)
  }
  listPanes(): PaneSummary[] {
    return [pane]
  }
  listAgents() {
    return [{ id: "claude-code", label: "Claude Code", available: true }]
  }
  listProjects() {
    return []
  }
  async startSession() {
    return { paneId: "p9", title: "p9" }
  }
  focusPane(): void {}
  async sendPrompt(paneId: string, text: string) {
    this.sent.push({ paneId, text })
  }
  async insertText(): Promise<void> {}
  async openFile(): Promise<void> {}
  async searchProject() {
    return []
  }
  setPaneView(): void {}
  browserNavigate(): void {}
  answerPermission(): void {}
  setColumns(): void {}
  setView(): void {}
  scrollTranscript(): void {}
  confirmVoiceSend(id: string, approved: boolean) {
    this.decisions.push([id, approved])
  }
  describeState(): VoiceStateSnapshot {
    return {
      totalSessions: 1,
      workingSessions: 1,
      waitingSessions: 0,
      doneSessions: 0,
      errorSessions: 0,
      currentView: "code",
      spokenSummary: "",
    }
  }
}

async function settle(ms = 5) {
  for (let i = 0; i < 12; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe("the plan's question does not cover a held message", () => {
  test("a message held while the planner thinks is asked first; the plan waits its turn", async () => {
    const host = new Host()
    const transcriber = createFakeTranscriber()
    const speaker = createFakeSpeaker()
    let release: (() => void) | undefined
    let clock = 10_000
    const engine = createVoiceEngine({
      host,
      transcriber,
      speaker,
      now: () => clock,
      plan: () =>
        new Promise((resolve) => {
          release = () => resolve(JSON.stringify([{ action: "send_prompt", paneIndex: 1, text: "esegui i test" }]))
        }),
      settings: { activation: "toggle", agentEngine: "auto" },
    })

    await engine.start()
    transcriber.emit("fai qualcosa di molto specifico con il terminale", true)
    await settle()
    expect(engine.status()).toBe("executing")

    // The voice agent writes to another session while the planner thinks.
    await engine.requestSendConfirmation("m1", "Alfa", "cancella dist")
    release!()
    await settle()

    // The message is the question on the floor, and the plan is in line.
    expect(engine.status()).toBe("confirming")
    expect(speaker.lastSpoken).not.toContain("Prima di premere Invio")

    transcriber.emit("sì", true)
    await settle()
    expect(host.decisions).toEqual([["m1", true]])
    expect(host.sent).toEqual([])

    // Now, and only now, the plan asks; its own yes, said once it is read, runs it.
    expect(engine.status()).toBe("confirming")
    expect(speaker.lastSpoken).toContain("esegui i test")
    clock += 15_000
    transcriber.emit("sì", true)
    await settle()
    expect(host.sent).toEqual([{ paneId: "p1", text: "esegui i test" }])
    await engine.stop()
  })

  test("a plan left behind is not run by the yes to another question", async () => {
    const host = new Host()
    const transcriber = createFakeTranscriber()
    const speaker = createFakeSpeaker()
    let release: (() => void) | undefined
    const engine = createVoiceEngine({
      host,
      transcriber,
      speaker,
      now: () => 10_000,
      plan: () =>
        new Promise((resolve) => {
          release = () => resolve(JSON.stringify([{ action: "send_prompt", paneIndex: 1, text: "esegui i test" }]))
        }),
      settings: { activation: "toggle", agentEngine: "auto" },
    })

    await engine.start()
    transcriber.emit("fai qualcosa di molto specifico con il terminale", true)
    await settle()
    await engine.requestSendConfirmation("m1", "Alfa", "cancella dist")
    release!()
    await settle()

    transcriber.emit("no", true) // refuses the message
    await settle()
    transcriber.emit("no", true) // refuses the plan
    await settle()
    expect(engine.status()).toBe("idle")

    transcriber.emit("chiudi il pannello 1", true)
    await settle()
    transcriber.emit("sì", true)
    await settle()
    expect(host.sent).toEqual([])
    await engine.stop()
  })
})
