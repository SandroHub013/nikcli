import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dispatch, VOCABULARY, type ParseResult } from "@ragu/voice"
import { codeOf } from "../test-support/source-text"
import { resetLocaleForTests } from "../i18n/locale"
import { createAdeVoiceHost, type AdeVoiceHostDeps } from "./host"
import type { VoiceAgent } from "./agent"
import { AGENTS } from "../session-new/agents"
import { createWorkbench, type Pane, type Workbench } from "../surface/state"
import { classifyAnswer, type PermissionAnswer, type PermissionRequest } from "../session/permission"
import type { Project } from "../host/project"
import { workbenchSource } from "../test-support/workbench-source"

function createMockDeps(overrides: Partial<AdeVoiceHostDeps> = {}): {
  deps: AdeVoiceHostDeps
  written: Record<string, string[]>
  appendedLines: { paneId: string; text: string; kind?: string }[]
  told: { paneId: string; text: string }[]
  commandsRun: string[]
  permissionsAnswered: { paneId: string; answer: PermissionAnswer }[]
  currentWb: () => Workbench
} {
  let wbState: Workbench = createWorkbench()
  let projectState: Project | undefined = undefined
  let permissionsState: Record<string, PermissionRequest> = {}
  const runningSessions = new Map<string, { write: (line: string) => void; kill?: () => void }>()
  const written: Record<string, string[]> = {}
  const appendedLines: { paneId: string; text: string; kind?: string }[] = []
  const told: { paneId: string; text: string }[] = []
  const commandsRun: string[] = []
  const permissionsAnswered: { paneId: string; answer: PermissionAnswer }[] = []

  const deps: AdeVoiceHostDeps = {
    wb: () => wbState,
    setWb: (updater) => {
      wbState = updater(wbState)
    },
    project: () => projectState,
    runCommand: async (id) => {
      commandsRun.push(id)
    },
    isRunning: (id) => runningSessions.has(id),
    getRunningSession: (id) => runningSessions.get(id),
    openFile: async () => {},
    appendLine: (paneId, text, kind) => {
      appendedLines.push({ paneId, text, kind })
    },
    tellPane: (paneId, text) => {
      told.push({ paneId, text })
    },
    permissions: () => permissionsState,
    answerPermission: (paneId, answer) => {
      permissionsAnswered.push({ paneId, answer })
      delete permissionsState[paneId]
    },
    ...overrides,
  }

  return {
    deps,
    written,
    appendedLines,
    told,
    commandsRun,
    permissionsAnswered,
    currentWb: () => wbState,
  }
}

function makePane(overrides: Partial<Pane> = {}): Pane {
  return {
    id: "p1",
    title: "Session 1",
    status: "working",
    model: "test-agent",
    mode: "auto",
    lines: [],
    workspaceId: "ws1",
    ...overrides,
  }
}

describe("createAdeVoiceHost", () => {
  test("a command that opens a pane brings the Code view up; one that does not leaves the view alone", async () => {
    const { deps, commandsRun, currentWb } = createMockDeps()
    deps.setWb((w) => ({ ...w, view: "agent" }))
    const host = createAdeVoiceHost(deps)

    await host.runCommand("decisions.open")
    expect(currentWb().view).toBe("agent")
    await host.runCommand("app.new")
    expect(currentWb().view).toBe("code")
    expect(commandsRun).toEqual(["decisions.open", "app.new"])
  })

  test("listPanes produces 1-based indices and consistent flags", () => {
    const { deps, currentWb } = createMockDeps()
    deps.setWb((w) => ({
      ...w,
      panes: [
        makePane({ id: "p1", title: "Session", status: "working" }),
        makePane({ id: "p2", title: "Browser", status: "done", browserUrl: "http://localhost:3000" }),
        makePane({ id: "p3", title: "File", status: "done", filePath: "/path/to/file.ts" }),
      ],
    }))

    // Mark p1 as running in fake deps
    const liveDeps: AdeVoiceHostDeps = {
      ...deps,
      isRunning: (id) => id === "p1",
    }

    const host = createAdeVoiceHost(liveDeps)
    const panes = host.listPanes()

    expect(panes).toHaveLength(3)

    expect(panes[0]).toEqual({
      id: "p1",
      title: "Session",
      status: "working",
      index: 1,
      hasLiveProcess: true,
      isBrowser: false,
      isFile: false,
    })

    expect(panes[1]).toEqual({
      id: "p2",
      title: "Browser",
      status: "done",
      index: 2,
      hasLiveProcess: false,
      isBrowser: true,
      isFile: false,
    })

    expect(panes[2]).toEqual({
      id: "p3",
      title: "File",
      status: "done",
      index: 3,
      hasLiveProcess: false,
      isBrowser: false,
      isFile: true,
    })
  })

  test("MOD2-1: two projects, each with «Sessione 1 — Claude Code»; «invia a sessione 1» and «pannello 1» reach the open project's pane", async () => {
    const writtenA: string[] = []
    const writtenB: string[] = []
    const sessionA = { write: (line: string) => void writtenA.push(line) }
    const sessionB = { write: (line: string) => void writtenB.push(line) }

    const projA: Project = { name: "progetto-a", root: "C:/projects/a", git: true }
    const projB: Project = { name: "progetto-b", root: "C:/projects/b", git: true }

    const { deps } = createMockDeps({
      project: () => projB,
      isRunning: () => true,
      getRunningSession: (id) => (id === "p-a1" ? sessionA : id === "p-b1" ? sessionB : undefined),
    })

    deps.setWb((w) => ({
      ...w,
      panes: [
        makePane({ id: "p-a1", title: "Sessione 1 — Claude Code", projectRoot: "C:/projects/a", workspaceId: "progetto-a", status: "working" }),
        makePane({ id: "p-b1", title: "Sessione 1 — Claude Code", projectRoot: "C:/projects/b", workspaceId: "progetto-b", status: "waiting" }),
      ],
    }))

    const host = createAdeVoiceHost(deps)
    const panes = host.listPanes()
    expect(panes).toHaveLength(1)
    expect(panes[0]!.id).toBe("p-b1")
    expect(panes[0]!.index).toBe(1)

    const state = host.describeState()
    expect(state.totalSessions).toBe(1)
    expect(state.waitingSessions).toBe(1)
    expect(state.workingSessions).toBe(0)

    const spec = VOCABULARY.find((v) => v.intent === "prompt.send")!
    const makeParse = (slots: Record<string, any>): ParseResult => ({
      outcome: "matched",
      intent: spec,
      slots,
      confidence: 1,
      candidates: [],
      rawUtterance: "",
      normalizedUtterance: "",
    })

    // «pannello 1» reaches the open project's pane
    const resIndex = await dispatch(makeParse({ paneIndex: 1, text: "test index" }), host)
    expect(resIndex.success).toBe(true)
    expect(writtenB).toContain("test index\r")
    expect(writtenA).toHaveLength(0)

    // «invia a sessione 1» (title match) reaches the open project's pane
    const resTitle = await dispatch(makeParse({ paneTitle: "Sessione 1 — Claude Code", text: "test title" }), host)
    expect(resTitle.success).toBe(true)
    expect(writtenB).toContain("test title\r")
    expect(writtenA).toHaveLength(0)
  })

  test("sendPrompt rejects with a descriptive message on pane without live process", async () => {
    const { deps } = createMockDeps({
      isRunning: () => false,
    })
    const host = createAdeVoiceHost(deps)

    expect(host.sendPrompt("p-dead", "ciao agente")).rejects.toThrow("Il pannello 'p-dead' non ha un processo vivo")
  })

  test("sendPrompt writes one submitted line and shows what it sent", async () => {
    const writtenLines: string[] = []
    const session = {
      write: (line: string) => writtenLines.push(line),
    }

    const { deps, appendedLines } = createMockDeps({
      isRunning: (id) => id === "p1",
      getRunningSession: (id) => (id === "p1" ? session : undefined),
    })
    const host = createAdeVoiceHost(deps)

    await host.sendPrompt("p1", "prima riga\nseconda riga")

    /*
     * Terminated, because the transcript below already claims it was sent.
     * Without the terminator the words sat unread in the agent's input line
     * while the user watched their own message appear and waited.
     */
    expect(writtenLines).toEqual([`prima riga seconda riga${String.fromCharCode(13)}`])
    // And the transcript shows the whole message, not only its first line:
    // half a dictated sentence is a confusing thing to be shown as sent.
    expect(appendedLines).toHaveLength(1)
    expect(appendedLines[0].text).toBe("> prima riga seconda riga")
  })

  test("sendPrompt cannot be made to submit twice", async () => {
    const writtenLines: string[] = []
    const session = { write: (line: string) => writtenLines.push(line) }
    const { deps } = createMockDeps({
      isRunning: () => true,
      getRunningSession: () => session,
    })
    const host = createAdeVoiceHost(deps)

    const CR = String.fromCharCode(13)
    await host.sendPrompt("p1", `innocuo${CR}git push --force`)

    expect(writtenLines[0].split(CR).length - 1).toBe(1)
  })

  /*
   * MOD-2: the user had typed «rm -rf build && » and not pressed Enter; the voice sent «esegui i test», and the agent
   * got «rm -rf build && esegui i test», submitted.
   */
  test("sendPrompt does not submit on top of the user's half-typed line, and says so with the words", async () => {
    const writtenLines: string[] = []
    const { deps, told } = createMockDeps({
      isRunning: () => true,
      getRunningSession: () => ({ write: (line: string) => writtenLines.push(line) }),
      isTyping: (id) => id === "p1",
    })
    const host = createAdeVoiceHost(deps)

    await expect(host.sendPrompt("p1", "esegui i test")).rejects.toThrow("riga scritta a metà")
    expect(writtenLines).toEqual([])
    expect(told).toHaveLength(1)
    expect(told[0]!.paneId).toBe("p1")
    expect(told[0]!.text).toContain("esegui i test")

    // Another pane, with nothing typed in it: sent.
    await host.sendPrompt("p2", "esegui i test")
    expect(writtenLines).toEqual([`esegui i test${String.fromCharCode(13)}`])
  })

  /*
   * Dictation has to survive a pane that has no composer.
   *
   * The composer only exists under panes with no live terminal now — under a
   * running session it was a second keyboard writing to the same pty, costing
   * every tile a row of terminal. `insertText` used to look for that textarea
   * and throw when it was absent, which is every running agent: transcription
   * mode, whose default send is "manual", would have failed on exactly the
   * panes it is for.
   */
  test("insertText reaches the terminal when the pane has no composer", async () => {
    const writtenLines: string[] = []
    const session = { write: (line: string) => writtenLines.push(line) }
    const { deps } = createMockDeps({
      isRunning: () => true,
      getRunningSession: () => session,
    })
    const host = createAdeVoiceHost(deps)

    await host.insertText("p1", "crea un componente")

    // Inserted, not submitted: no carriage return anywhere in what was written.
    expect(writtenLines).toEqual(["crea un componente "])
    expect(writtenLines[0]).not.toContain(String.fromCharCode(13))
  })

  test("insertText refuses rather than guessing when the pane can receive nothing", async () => {
    const { deps } = createMockDeps({
      isRunning: () => false,
      getRunningSession: () => undefined,
    })
    const host = createAdeVoiceHost(deps)

    expect(host.insertText("p1", "ciao")).rejects.toThrow("Il pannello selezionato non ha dove ricevere il testo.")
  })

  test("insertText throws when the write returned false (MOD3-1)", async () => {
    const session = { write: () => false }
    const { deps } = createMockDeps({
      isRunning: () => true,
      getRunningSession: () => session,
    })
    const host = createAdeVoiceHost(deps)

    await expect(host.insertText("p1", "testo")).rejects.toThrow(
      "il pannello non è pronto a ricevere testo; riprova tra poco",
    )
  })

  test("insertText never lets a dictated newline submit the line", async () => {
    const writtenLines: string[] = []
    const session = { write: (line: string) => writtenLines.push(line) }
    const { deps } = createMockDeps({
      isRunning: () => true,
      getRunningSession: () => session,
    })
    const host = createAdeVoiceHost(deps)

    const CR = String.fromCharCode(13)
    await host.insertText("p1", `innocuo${CR}git push --force`)

    expect(writtenLines[0]).not.toContain(CR)
    expect(writtenLines[0]).toBe("innocuo git push --force ")
  })

  test("answerPermission does nothing when no permission is pending", () => {
    let answered = false
    const { deps } = createMockDeps({
      permissions: () => ({}),
      answerPermission: () => {
        answered = true
      },
    })
    const host = createAdeVoiceHost(deps)

    // `false` is what lets the voice say so instead of «Permesso concesso».
    expect(host.answerPermission("p1", "allow")).toBe(false)
    expect(answered).toBe(false)

    expect(host.answerPermission("p1", "deny")).toBe(false)
    expect(answered).toBe(false)
  })

  test("answerPermission picks correct allow/deny answer when pending", () => {
    const answered: PermissionAnswer[] = []
    const pendingRequest: PermissionRequest = {
      what: "run command",
      kind: "shell",
      answers: [
        { intent: "yes", label: "Sì", send: "y", tone: "primary" },
        { intent: "no", label: "No", send: "n", tone: "secondary" },
      ],
    }

    const { deps } = createMockDeps({
      permissions: () => ({ p1: pendingRequest }),
      answerPermission: (_id, ans) => {
        answered.push(ans)
      },
    })
    const host = createAdeVoiceHost(deps)

    expect(host.answerPermission("p1", "allow")).toBe(true)
    expect(answered).toHaveLength(1)
    expect(answered[0].send).toBe("y")

    host.answerPermission("p1", "deny")
    expect(answered).toHaveLength(2)
    expect(answered[1].send).toBe("n")
  })

  // Full review 2026-10-06, ui 4: for Claude and Codex `what` is the same heading on every request, the command is the target.
  describe("the request whose question was read is told by its target too", () => {
    const heading = "Do you want to proceed?"
    const answers = [
      { intent: "yes" as const, label: "Sì", send: "1", tone: "primary" as const },
      { intent: "no" as const, label: "No", send: "3", tone: "secondary" as const },
    ]
    const request = (target: string): PermissionRequest => ({ what: heading, kind: "shell", target, answers })

    test("a yes read for «cat README» does not grant the «rm -rf ~» that came next with the same heading", () => {
      let open = request("cat README")
      const answered: PermissionAnswer[] = []
      const { deps } = createMockDeps({
        permissions: () => ({ p1: open }),
        answerPermission: (_id, answer) => void answered.push(answer),
      })
      const host = createAdeVoiceHost(deps)

      const read = host.pendingPermissionWhat?.("p1")
      open = request("rm -rf ~")

      expect(host.answerPermission("p1", "allow", read)).toBe(false)
      expect(answered).toHaveLength(0)
      expect(host.answerPermission("p1", "allow", host.pendingPermissionWhat?.("p1"))).toBe(true)
      expect(answered).toHaveLength(1)
    })

    test("a request without a target is still told by its heading alone", () => {
      const { deps } = createMockDeps({ permissions: () => ({ p1: { what: "run command", kind: "shell", answers } }) })
      const host = createAdeVoiceHost(deps)
      expect(host.pendingPermissionWhat?.("p1")).toBe("run command")
      expect(host.answerPermission("p1", "allow", "run command")).toBe(true)
    })
  })

  // F7e, D1: on Claude's «Would you like to proceed?» plan menu the first option is «use auto mode».
  test("a spoken yes on the plan menu chooses «manually approve edits», never an auto mode", () => {
    const answered: PermissionAnswer[] = []
    const labels = [
      "Yes, clear context and use auto mode",
      "Yes, auto-accept edits",
      "Yes, manually approve edits",
      "No, keep planning",
    ]
    const request: PermissionRequest = {
      what: "Would you like to proceed?",
      kind: "unknown",
      answers: labels.map((label, i) => ({
        intent: classifyAnswer(label),
        label,
        send: String(i + 1),
        tone: i === 0 ? ("primary" as const) : ("secondary" as const),
      })),
    }
    const { deps } = createMockDeps({
      permissions: () => ({ p1: request }),
      answerPermission: (_id, ans) => void answered.push(ans),
    })
    expect(createAdeVoiceHost(deps).answerPermission("p1", "allow")).toBe(true)
    expect(answered.map((a) => a.label)).toEqual(["Yes, manually approve edits"])
  })

  // F7e, N2: «No, and always deny» is a refusal that lasts; a spoken no takes the plain one, wherever it is in the menu.
  describe("a spoken no prefers the refusal that is not permanent", () => {
    const refuse = (labels: string[]) => {
      const answered: PermissionAnswer[] = []
      const { deps } = createMockDeps({
        permissions: () => ({
          p1: {
            what: "Run it?",
            kind: "shell",
            answers: labels.map((label, i) => ({
              intent: classifyAnswer(label),
              label,
              send: String(i + 1),
              tone: i === 0 ? ("primary" as const) : ("secondary" as const),
            })),
          },
        }),
        answerPermission: (_id, answer) => void answered.push(answer),
      })
      createAdeVoiceHost(deps).answerPermission("p1", "deny")
      return answered.map((a) => a.label)
    }

    test("the permanent refusal first in the menu", () => {
      expect(refuse(["Yes", "No, and always deny", "No"])).toEqual(["No"])
    })
    test("the plain one first", () => {
      expect(refuse(["Yes", "No", "No, and always deny"])).toEqual(["No"])
    })
    test("when only the permanent refusal is left it is still a refusal, as before", () => {
      expect(refuse(["Yes", "No, and always deny"])).toEqual(["No, and always deny"])
    })
  })

  // F7e review, low 1: a spoken yes never takes an answer that widens the reach, and sends nothing when it is all that is offered.
  test("a spoken yes does not choose «Run all commands», «Continue without sandbox» or «Approve for this project»", () => {
    const answered: PermissionAnswer[] = []
    const labels = ["Run all commands", "Continue without sandbox", "Approve for this project", "Permetti per questa cartella"]
    const request = (list: string[]): PermissionRequest => ({
      what: "Proceed?",
      kind: "unknown",
      answers: list.map((label, i) => ({
        intent: classifyAnswer(label),
        label,
        send: String(i + 1),
        tone: i === 0 ? ("primary" as const) : ("secondary" as const),
      })),
    })
    let open = request(labels)
    const { deps } = createMockDeps({
      permissions: () => ({ p1: open }),
      answerPermission: (_id, ans) => void answered.push(ans),
    })
    const host = createAdeVoiceHost(deps)
    expect(host.answerPermission("p1", "allow")).toBe(false)
    expect(answered).toHaveLength(0)
    open = request([...labels, "Yes, once"])
    expect(host.answerPermission("p1", "allow")).toBe(true)
    expect(answered.map((a) => a.label)).toEqual(["Yes, once"])
  })

  // F7e, D2: a label nobody recognised is not a yes, whatever its place in the menu.
  describe("a spoken yes sends only an answer that is a yes", () => {
    const grant = (answers: PermissionRequest["answers"]) => {
      const answered: PermissionAnswer[] = []
      const { deps } = createMockDeps({
        permissions: () => ({ p1: { what: "Which library should I use?", kind: "unknown", answers } }),
        answerPermission: (_id, answer) => void answered.push(answer),
      })
      const sent = createAdeVoiceHost(deps).answerPermission("p1", "allow")
      return { answered, sent }
    }
    const menu = (labels: string[]): PermissionRequest["answers"] =>
      labels.map((label, i) => ({
        intent: classifyAnswer(label),
        label,
        send: String(i + 1),
        tone: i === 0 ? ("primary" as const) : ("secondary" as const),
      }))

    test("a question menu [React, Vue, Svelte] gets nothing", () => {
      const { answered, sent } = grant(menu(["React", "Vue", "Svelte"]))
      expect(sent).toBe(false)
      expect(answered).toHaveLength(0)
    })

    test("a menu that starts with «Not now» gets nothing", () => {
      const { answered, sent } = grant(menu(["Not now", "Remind me tomorrow"]))
      expect(sent).toBe(false)
      expect(answered).toHaveLength(0)
    })

    test("a yes that is not the primary one is still found, and the primary yes is preferred", () => {
      const { answered } = grant(menu(["Show me the diff", "Okay", "Yes", "No"]))
      expect(answered.map((a) => a.label)).toEqual(["Okay"])
      expect(grant(menu(["Open the file", "Yes"])).answered.map((a) => a.label)).toEqual(["Yes"])
    })
  })

  // Same review, ui 4 (c): «Allow always» is not what a spoken yes means.
  describe("a spoken yes never takes the permanent answer", () => {
    const grant = (answers: PermissionRequest["answers"]) => {
      const answered: PermissionAnswer[] = []
      const { deps } = createMockDeps({
        permissions: () => ({ p1: { what: "Bash command", kind: "shell", answers } }),
        answerPermission: (_id, answer) => void answered.push(answer),
      })
      const sent = createAdeVoiceHost(deps).answerPermission("p1", "allow")
      return { answered, sent }
    }

    test("with [Allow always, Allow once, Deny] it picks Allow once", () => {
      const { answered } = grant([
        { intent: "always", label: "Allow always", send: "1", tone: "primary" },
        { intent: "once", label: "Allow once", send: "2", tone: "secondary" },
        { intent: "no", label: "Deny", send: "3", tone: "secondary" },
      ])
      expect(answered.map((answer) => answer.send)).toEqual(["2"])
    })

    test("with [«Sì, e non chiedere più», «Sì, solo questa volta», No] it picks the single one", () => {
      const { answered } = grant([
        { intent: "always", label: "Sì, e non chiedere più", send: "1", tone: "primary" },
        { intent: "once", label: "Sì, solo questa volta", send: "2", tone: "secondary" },
        { intent: "no", label: "No", send: "3", tone: "secondary" },
      ])
      expect(answered.map((answer) => answer.send)).toEqual(["2"])
    })

    // Review of F6c, N1: Claude Code's edit permission offers «Yes, allow all edits during this session» as its second option.
    test("«allow all edits during this session» is not the single yes", () => {
      const { answered } = grant([
        { intent: "always", label: "Yes, allow all edits during this session", send: "2", tone: "primary" },
        { intent: "yes", label: "Yes", send: "1", tone: "secondary" },
        { intent: "no", label: "No", send: "3", tone: "secondary" },
      ])
      expect(answered.map((answer) => answer.send)).toEqual(["1"])
    })

    // Full review 2026-10-06, sessions 13: the voice reads what an answer does (`intent`), not the words on the button.
    test("the answer is told by its intent, whatever language or wording the button has", () => {
      const { answered } = grant([
        { intent: "always", label: "Autorizar siempre", send: "1", tone: "primary" },
        { intent: "yes", label: "Autorizar", send: "2", tone: "secondary" },
        { intent: "no", label: "Rechazar", send: "3", tone: "secondary" },
      ])
      expect(answered.map((answer) => answer.send)).toEqual(["2"])
    })

    test("a refusal is found by its intent in a wording the old patterns did not know", () => {
      const answered: PermissionAnswer[] = []
      const { deps } = createMockDeps({
        permissions: () => ({
          p1: {
            what: "Bash command",
            kind: "shell",
            answers: [
              { intent: "yes", label: "Autorizar", send: "1", tone: "primary" },
              { intent: "no", label: "Rechazar", send: "2", tone: "secondary" },
            ],
          },
        }),
        answerPermission: (_id, answer) => void answered.push(answer),
      })
      expect(createAdeVoiceHost(deps).answerPermission("p1", "deny")).toBe(true)
      expect(answered.map((answer) => answer.send)).toEqual(["2"])
    })

    test("with only the permanent answer and a refusal, nothing is sent", () => {
      const { answered, sent } = grant([
        { intent: "always", label: "Allow always", send: "1", tone: "primary" },
        { intent: "no", label: "Deny", send: "2", tone: "secondary" },
      ])
      expect(sent).toBe(false)
      expect(answered).toHaveLength(0)
    })
  })

  test("permission speech exposes only the safe kind while the raw request still identifies the answer", () => {
    const raw = "curl -H 'Authorization: Bearer API_KEY_SECRET' https://example.test/export"
    const answered: PermissionAnswer[] = []
    const { deps } = createMockDeps({
      permissions: () => ({
        p1: {
          what: raw,
          kind: "shell",
          answers: [
            { intent: "yes", label: "Sì", send: "y", tone: "primary" },
            { intent: "no", label: "No", send: "n", tone: "secondary" },
          ],
        },
      }),
      answerPermission: (_id, answer) => void answered.push(answer),
      locale: () => "it",
    })
    const host = createAdeVoiceHost(deps)

    expect(host.pendingPermissionWhat?.("p1")).toBe(raw)
    expect(host.pendingPermissionKind?.("p1")).toBe("shell")
    expect(host.answerPermission("p1", "allow", "another raw request")).toBe(false)
    expect(host.answerPermission("p1", "allow", raw)).toBe(true)
    expect(answered.map((answer) => answer.send)).toEqual(["y"])
  })

  /*
   * The one failure this path must not have. "Deny" used to fall back to the
   * second option, whatever it was — so on a question whose options are
   * "Allow once" and "Allow always", saying "nega" out loud granted the
   * permission permanently, by voice, with no confirmation.
   */
  describe("a spoken refusal can never grant", () => {
    const permissive: PermissionRequest = {
      what: "Bash command",
      kind: "shell",
      answers: [
        { intent: "once", label: "Consenti una volta", send: "1", tone: "primary" },
        { intent: "always", label: "Sì, e non chiedere più", send: "2", tone: "secondary" },
      ],
    }

    test("nothing is sent when no answer is a refusal", () => {
      const answered: PermissionAnswer[] = []
      const { deps, told } = createMockDeps({
        permissions: () => ({ p1: permissive }),
        answerPermission: (_id, ans) => {
          answered.push(ans)
        },
      })

      createAdeVoiceHost(deps).answerPermission("p1", "deny")

      expect(answered).toHaveLength(0)
      // And the user is told, over the terminal too, so the request does not simply appear ignored.
      expect(told.some((line) => line.text.includes("rifiuto"))).toBe(true)
    })

    test("a refusal is still found when one is offered third", () => {
      const answered: PermissionAnswer[] = []
      const { deps } = createMockDeps({
        permissions: () => ({
          p1: {
            ...permissive,
            answers: [...permissive.answers, { intent: "no" as const, label: "No", send: "3", tone: "secondary" as const }],
          },
        }),
        answerPermission: (_id, ans) => {
          answered.push(ans)
        },
      })

      createAdeVoiceHost(deps).answerPermission("p1", "deny")

      expect(answered).toHaveLength(1)
      expect(answered[0].send).toBe("3")
    })

    test("allow still works on an all-permissive question", () => {
      const answered: PermissionAnswer[] = []
      const { deps } = createMockDeps({
        permissions: () => ({ p1: permissive }),
        answerPermission: (_id, ans) => {
          answered.push(ans)
        },
      })

      createAdeVoiceHost(deps).answerPermission("p1", "allow")

      expect(answered).toHaveLength(1)
      expect(answered[0].send).toBe("1")
    })
  })

  test("describeState counts sessions, not panels: video, 3D, simulator, file, browser and plugin tiles do not count", () => {
    const { deps } = createMockDeps()
    deps.setWb((w) => ({
      ...w,
      panes: [
        makePane({ id: "p1", status: "working" }),
        // An empty player: no path yet, so only its mode says what it is.
        makePane({ id: "p2", status: "done", mode: "video", videoPath: "" }),
        makePane({ id: "p3", status: "done", modelPath: "/m.glb" }),
        makePane({ id: "p4", status: "done", appUrl: "http://localhost:5173" }),
        makePane({ id: "p5", status: "done", filePath: "/src/index.ts" }),
        makePane({ id: "p6", status: "done", browserUrl: "http://localhost:3000" }),
        makePane({ id: "p7", status: "done", plugin: { pluginId: "x", name: "Tile" } }),
        // A panel is known by its mode as well: Decisioni has no path at all,
        // and its status is the session's «working» until it is answered.
        makePane({ id: "p8", status: "working", mode: "decisions" }),
        makePane({ id: "p9", status: "working", mode: "app" }),
      ],
    }))
    const state = createAdeVoiceHost(deps).describeState()
    expect(state.totalSessions).toBe(1)
    expect(state.workingSessions).toBe(1)
    expect(state.spokenSummary.toLowerCase()).toContain("una sessione")
  })

  test("describeState produces correct Italian grammatical number for 0, 1 and 3 sessions", () => {
    // 0 sessions
    const { deps: deps0 } = createMockDeps()
    const host0 = createAdeVoiceHost(deps0)
    const state0 = host0.describeState()
    expect(state0.totalSessions).toBe(0)
    expect(state0.spokenSummary.toLowerCase()).toContain("nessuna sessione")

    // 1 session
    const { deps: deps1 } = createMockDeps()
    deps1.setWb((w) => ({
      ...w,
      panes: [makePane({ id: "p1", status: "working" })],
    }))
    const host1 = createAdeVoiceHost(deps1)
    const state1 = host1.describeState()
    expect(state1.totalSessions).toBe(1)
    expect(state1.spokenSummary.toLowerCase()).toContain("una sessione")
    expect(state1.spokenSummary).toContain("in esecuzione")

    // 3 sessions
    const { deps: deps3 } = createMockDeps()
    deps3.setWb((w) => ({
      ...w,
      panes: [
        makePane({ id: "p1", status: "working" }),
        makePane({ id: "p2", status: "waiting" }),
        makePane({ id: "p3", status: "done" }),
      ],
    }))
    const host3 = createAdeVoiceHost(deps3)
    const state3 = host3.describeState()
    expect(state3.totalSessions).toBe(3)
    expect(state3.spokenSummary.toLowerCase()).toContain("tre sessioni")
    expect(state3.spokenSummary).toContain("in esecuzione")
    expect(state3.spokenSummary).toContain("in attesa")
    expect(state3.spokenSummary).toContain("completata")
  })

  // Full review 2026-10-06, ui 15: the waiting count past the table of words fell back to the working one.
  test("describeState says the waiting count, not the working one, when it has no word", () => {
    const { deps } = createMockDeps()
    deps.setWb((w) => ({
      ...w,
      panes: [
        makePane({ id: "w1", status: "working" }),
        ...Array.from({ length: 11 }, (_, i) => makePane({ id: `a${i}`, status: "waiting" })),
      ],
    }))
    const summary = createAdeVoiceHost(deps).describeState().spokenSummary
    expect(summary).toContain("11 in attesa")
    expect(summary).not.toMatch(/(?<!\d)1 in attesa/)
  })

  test("describeState produces correct English grammatical number for 0, 1 and 3 sessions", () => {
    // 0 sessions
    const { deps: deps0 } = createMockDeps({ locale: () => "en" })
    const host0 = createAdeVoiceHost(deps0)
    const state0 = host0.describeState()
    expect(state0.totalSessions).toBe(0)
    expect(state0.spokenSummary.toLowerCase()).toContain("no open sessions")

    // 1 session
    const { deps: deps1 } = createMockDeps({ locale: () => "en" })
    deps1.setWb((w) => ({
      ...w,
      panes: [makePane({ id: "p1", status: "working" })],
    }))
    const host1 = createAdeVoiceHost(deps1)
    const state1 = host1.describeState()
    expect(state1.totalSessions).toBe(1)
    expect(state1.spokenSummary.toLowerCase()).toContain("one session")
    expect(state1.spokenSummary).toContain("running")

    // 3 sessions
    const { deps: deps3 } = createMockDeps({ locale: () => "en" })
    deps3.setWb((w) => ({
      ...w,
      panes: [
        makePane({ id: "p1", status: "working" }),
        makePane({ id: "p2", status: "waiting" }),
        makePane({ id: "p3", status: "done" }),
      ],
    }))
    const host3 = createAdeVoiceHost(deps3)
    const state3 = host3.describeState()
    expect(state3.totalSessions).toBe(3)
    expect(state3.spokenSummary.toLowerCase()).toContain("three open sessions")
    expect(state3.spokenSummary).toContain("running")
    expect(state3.spokenSummary).toContain("waiting")
    expect(state3.spokenSummary).toContain("completed")
  })

  test("focusPane and browserNavigate update workbench state", () => {
    const { deps, currentWb } = createMockDeps()
    deps.setWb((w) => ({
      ...w,
      panes: [makePane({ id: "b1", browserUrl: "http://localhost:3000" })],
    }))
    const host = createAdeVoiceHost(deps)

    host.focusPane("b1")
    expect(currentWb().focusedId).toBe("b1")

    host.browserNavigate("b1", "http://localhost:5173")
    expect(currentWb().panes[0].browserUrl).toBe("http://localhost:5173")
  })

  // MOD-1: «apri localhost 5173» with a Claude pane focused turned the agent's terminal into a browser.
  test("browserNavigate leaves a session's pane a session", () => {
    const { deps, currentWb } = createMockDeps()
    deps.setWb((w) => ({ ...w, panes: [makePane({ id: "p1", title: "Claude", agent: "claude-code" })] }))
    const host = createAdeVoiceHost(deps)

    expect(host.browserNavigate("p1", "http://localhost:5173")).toBe(false)
    expect(currentWb().panes[0].browserUrl).toBeUndefined()
  })

  test("listPanes carries the agent of a session, so the planner can tell «Mimo» from «Dario»", () => {
    const { deps } = createMockDeps()
    deps.setWb((w) => ({
      ...w,
      panes: [
        makePane({ id: "p1", title: "Mimo", status: "waiting", agent: "opencode" }),
        makePane({ id: "p2", title: "Nota" }),
      ],
    }))
    const panes = createAdeVoiceHost(deps).listPanes()
    expect(panes[0]).toMatchObject({ title: "Mimo", status: "waiting", agent: "opencode" })
    expect(panes[1]).not.toHaveProperty("agent")
  })

  test("plan goes to the voice agent, with what the engine sent", async () => {
    const seen: unknown[] = []
    const agent: VoiceAgent = {
      ask: async () => ({ ok: true, text: "", ran: true }),
      plan: async (request) => {
        seen.push(request)
        return '{"speech":"ok","steps":[]}'
      },
      prepare: () => {},
      forget: () => {},
      release: () => {},
    }
    const { deps } = createMockDeps({ voiceAgentFactory: async () => agent })
    const host = createAdeVoiceHost(deps)
    const request = { system: "R", user: "U", engine: "claude" as const, speed: "fast" as const }
    expect(await host.plan!(request)).toBe('{"speech":"ok","steps":[]}')
    expect(seen).toEqual([request])
  })

  // Full review 2026-10-06, ui 20: a rejected start was kept for good.
  test("a voice agent that failed to start is started again at the next sentence", async () => {
    let starts = 0
    const agent: VoiceAgent = {
      ask: async () => ({ ok: true, text: "fatto", ran: true }),
      plan: async () => "[]",
      prepare: () => {},
      forget: () => {},
      release: () => {},
    }
    const { deps } = createMockDeps({
      voiceAgentFactory: async () => {
        starts++
        if (starts === 1) throw new Error("import fallito")
        return agent
      },
    })
    const host = createAdeVoiceHost(deps)
    const request = { text: "ciao", engine: "claude" as const }
    await expect(host.askAgent!(request)).rejects.toThrow("import fallito")
    expect((await host.askAgent!(request)).text).toBe("fatto")
    expect(starts).toBe(2)
  })

  test("releasing the voice cancels a prepare waiting for a project", async () => {
    let project: Project | undefined
    let prepares = 0
    const agent: VoiceAgent = {
      ask: async () => ({ ok: false, text: "", ran: false }),
      plan: async () => "[]",
      prepare: () => {
        prepares++
      },
      forget: () => {},
      release: () => {},
    }
    const { deps } = createMockDeps({
      project: () => project,
      voiceAgentFactory: async () => agent,
    })
    const host = createAdeVoiceHost(deps)

    host.prepareAgent!({ engine: "claude" })
    host.releaseAgent!()
    project = { root: "C:/project", name: "project", git: true }
    await new Promise((resolve) => setTimeout(resolve, 600))

    expect(prepares).toBe(0)
  })
})

/**
 * The three capabilities a spoken plan needs before it can act: what can be
 * started, where, and starting one.
 *
 * The pane itself is made by the workbench — a `.tsx` no test can import — so
 * `openAgentSession` is faked here with a counter. What is under test is the
 * part that lives in this module: which agent id was resolved, which project
 * was switched to, and that each call carries its own task.
 */
describe("createAdeVoiceHost, spoken planning", () => {
  const ragu: Project = { root: "C:/Users/x/ragu", name: "ragu", git: true }

  function planningDeps(overrides: Partial<AdeVoiceHostDeps> = {}) {
    const started: { agentId: string; task: string }[] = []
    const switched: string[] = []
    let opened = 0

    const { deps } = createMockDeps({
      openAgentSession: (input) => {
        started.push(input)
        opened += 1
        return { paneId: `voice-${opened}`, title: input.task || `Sessione ${opened}` }
      },
      switchProject: async (root) => {
        switched.push(root)
      },
      ...overrides,
    })

    return { deps, started, switched }
  }

  test("listAgents lists the whole catalogue, not a subset", () => {
    const { deps } = planningDeps()
    const agents = createAdeVoiceHost(deps).listAgents!()

    expect(agents).toHaveLength(AGENTS.length)
    expect(agents.find((a) => a.id === "claude-code")?.label).toBe("Claude Code")
  })

  test("listAgents reports an agent the probe did not find as unavailable", () => {
    const { deps } = planningDeps({
      agentAvailability: () =>
        AGENTS.map((agent) => ({
          agent,
          availability: agent.id === "codex" ? ("assente" as const) : ("presente" as const),
        })),
    })

    const agents = createAdeVoiceHost(deps).listAgents!()

    expect(agents.find((a) => a.id === "codex")?.available).toBe(false)
    expect(agents.find((a) => a.id === "claude-code")?.available).toBe(true)
  })

  /*
   * A probe that has not answered yet must never read as "not installed": the
   * user would be told to install an agent they already have.
   */
  test("listAgents calls every agent available while availability is unknown", () => {
    const { deps } = planningDeps({ agentAvailability: () => undefined })
    const agents = createAdeVoiceHost(deps).listAgents!()

    expect(agents.every((a) => a.available)).toBe(true)
  })

  test("listProjects marks only the open project, and dedupes it from the recents", () => {
    const { deps } = planningDeps({
      project: () => ragu,
      // The same directory as the open one, spelled the way a shell spells it.
      recents: () => [
        { root: "C:\\Users\\x\\ragu", name: "ragu", openedAt: 2 },
        { root: "C:/Users/x/altro", name: "altro", openedAt: 1 },
      ],
    })

    const projects = createAdeVoiceHost(deps).listProjects!()

    expect(projects.map((p) => p.name)).toEqual(["ragu", "altro"])
    expect(projects.map((p) => p.isOpen)).toEqual([true, false])
  })

  test("startSession resolves a spoken agent name and returns the pane it made", async () => {
    const { deps, started } = planningDeps({ project: () => ragu })

    const pane = await createAdeVoiceHost(deps).startSession!({
      agent: "Claude",
      task: "sistema il parser",
    })

    expect(started).toEqual([{ agentId: "claude-code", task: "sistema il parser" }])
    expect(pane.paneId).toBe("voice-1")
    expect(pane.title).toBe("sistema il parser")
  })

  /*
   * «avvia 4 sessioni claude, una sul parser, una sui test» è il caso che ha
   * fatto nascere questa capability: quattro chiamate, quattro compiti
   * diversi, quattro pannelli distinti a cui poter parlare dopo.
   */
  test("four calls produce four panes with four different tasks", async () => {
    const { deps, started } = planningDeps({ project: () => ragu })
    const host = createAdeVoiceHost(deps)

    const tasks = ["il parser", "i test", "la documentazione", "le prestazioni"]
    const panes = await Promise.all(tasks.map((task) => host.startSession!({ agent: "claude", task })))

    expect(started.map((s) => s.task)).toEqual(tasks)
    expect(new Set(panes.map((p) => p.paneId)).size).toBe(4)
    expect(panes.map((p) => p.title)).toEqual(tasks)
  })

  test("startSession refuses an agent that does not exist, and opens nothing", async () => {
    const { deps, started } = planningDeps({ project: () => ragu })

    await expect(createAdeVoiceHost(deps).startSession!({ agent: "aider", task: "qualsiasi cosa" })).rejects.toThrow(
      /Non conosco l'agente «aider»/,
    )
    expect(started).toHaveLength(0)
  })

  test("startSession switches project first when the task names another one", async () => {
    const { deps, started, switched } = planningDeps({
      project: () => ragu,
      recents: () => [{ root: "C:/Users/x/altro", name: "altro", openedAt: 1 }],
    })

    await createAdeVoiceHost(deps).startSession!({
      agent: "codex",
      task: "i test",
      project: "Altro",
    })

    expect(switched).toEqual(["C:/Users/x/altro"])
    expect(started).toEqual([{ agentId: "codex", task: "i test" }])
  })

  test("startSession does not switch when the named project is the open one", async () => {
    const { deps, switched } = planningDeps({
      project: () => ragu,
      recents: () => [{ root: "C:\\Users\\x\\ragu", name: "ragu", openedAt: 1 }],
    })

    await createAdeVoiceHost(deps).startSession!({ agent: "claude", project: "ragu" })

    expect(switched).toEqual([])
  })

  test("startSession refuses an unknown project without opening or switching anything", async () => {
    const { deps, started, switched } = planningDeps({
      project: () => ragu,
      recents: () => [{ root: "C:/Users/x/altro", name: "altro", openedAt: 1 }],
    })

    await expect(createAdeVoiceHost(deps).startSession!({ agent: "claude", project: "contabilità" })).rejects.toThrow(
      /Non conosco il progetto/,
    )
    expect(switched).toEqual([])
    expect(started).toHaveLength(0)
  })

  /*
   * Senza progetto aperto `startProcess` rinuncia in silenzio: il pannello
   * resta su «Inizializzazione» e l'assistente direbbe che è partito.
   */
  test("startSession asks which project instead of opening a pane that cannot start", async () => {
    const { deps, started } = planningDeps({ project: () => undefined })

    await expect(createAdeVoiceHost(deps).startSession!({ agent: "claude", task: "i test" })).rejects.toThrow(
      /nessun progetto aperto/,
    )
    expect(started).toHaveLength(0)
  })

  test("startSession says so instead of pretending when the host cannot open sessions", async () => {
    const { deps } = createMockDeps({ project: () => ragu })

    await expect(createAdeVoiceHost(deps).startSession!({ agent: "claude" })).rejects.toThrow(
      "Non posso avviare sessioni da qui.",
    )
  })

  test("the same refusal is said in English with the interface in English (F7b)", async () => {
    resetLocaleForTests("en")
    try {
      const { deps } = createMockDeps({ project: () => ragu })
      await expect(createAdeVoiceHost(deps).startSession!({ agent: "claude" })).rejects.toThrow(
        "I can't start sessions from here.",
      )
    } finally {
      resetLocaleForTests("it")
    }
  })
})

/*
 * V1-bis, ALTO 3: the grant is for the request whose question was read. A
 * pane whose request changed since then (the first answered by hand, a new
 * one asked) is not answered.
 */
describe("answerPermission answers only the request that was asked", () => {
  const request = (what: string): PermissionRequest => ({
    what,
    kind: "shell",
    answers: [
      { intent: "yes", label: "Sì", send: "y", tone: "primary" },
      { intent: "no", label: "No", send: "n", tone: "secondary" },
    ],
  })

  test("a different request on the pane is not granted", () => {
    const answered: PermissionAnswer[] = []
    const { deps } = createMockDeps({
      permissions: () => ({ p1: request("rm -rf ~") }),
      answerPermission: (_id, ans) => void answered.push(ans),
    })
    const host = createAdeVoiceHost(deps)
    expect(host.answerPermission("p1", "allow", "cat README")).toBe(false)
    expect(answered).toEqual([])
  })

  test("the same request is", () => {
    const answered: PermissionAnswer[] = []
    const { deps } = createMockDeps({
      permissions: () => ({ p1: request("cat README") }),
      answerPermission: (_id, ans) => void answered.push(ans),
    })
    const host = createAdeVoiceHost(deps)
    expect(host.answerPermission("p1", "allow", "cat README")).toBe(true)
    expect(answered.map((a) => a.send)).toEqual(["y"])
  })
  test("a stale deny cannot answer a changed request", () => {
    let pending = request("curl first-secret")
    const answered: PermissionAnswer[] = []
    const { deps } = createMockDeps({
      permissions: () => ({ p1: pending }),
      answerPermission: (_id, answer) => void answered.push(answer),
    })
    const host = createAdeVoiceHost(deps)

    pending = request("curl second-secret")
    expect(host.answerPermission("p1", "deny", "curl first-secret")).toBe(false)
    expect(answered).toEqual([])

    pending = request("curl first-secret")
    expect(host.answerPermission("p1", "deny", "curl first-secret")).toBe(true)
    expect(answered.map((answer) => answer.send)).toEqual(["n"])
  })
})

/*
 * V1-bis, ALTO 6: dictating to a pane whose agent has a permission question
 * open, «invia» typed the text and Enter into the menu, and Enter picks the
 * highlighted option — the permission granted without a word about it. A
 * pane with a question open takes no text from the voice until it is answered.
 */
describe("no voice text into a pane asking a permission", () => {
  const asking: PermissionRequest = {
    what: "rm -rf build",
    kind: "shell",
    answers: [
      { intent: "yes", label: "Sì", send: "1", tone: "primary" },
      { intent: "no", label: "No", send: "3", tone: "secondary" },
    ],
  }

  test("sendPrompt refuses, and nothing reaches the terminal", async () => {
    const writtenLines: string[] = []
    const { deps } = createMockDeps({
      isRunning: (id) => id === "p1",
      getRunningSession: (id) => (id === "p1" ? { write: (line: string) => void writtenLines.push(line) } : undefined),
      permissions: () => ({ p1: asking }),
    })
    const host = createAdeVoiceHost(deps)
    await expect(host.sendPrompt("p1", "sistema i test")).rejects.toThrow("permesso")
    expect(writtenLines).toEqual([])
  })

  /*
   * Review of invio-giusto, B1: a codex or OpenCode menu is read off the screen and never enters `permissions`. The
   * voice wrote anyway, the workbench held the write in silence, and the voice said «inviata» over text that was gone.
   */
  test("sendPrompt refuses on a question only the screen or the hook knows, and keeps the words over the pane", async () => {
    const writtenLines: string[] = []
    const { deps, told } = createMockDeps({
      isRunning: () => true,
      getRunningSession: () => ({ write: (line: string) => void writtenLines.push(line) }),
      permissions: () => ({}),
      questionOpen: (id) => id === "p1",
    })
    const host = createAdeVoiceHost(deps)

    await expect(host.sendPrompt("p1", "rifai la migrazione")).rejects.toThrow("permesso")
    await expect(host.insertText("p1", "e poi i test")).rejects.toThrow("permesso")
    expect(writtenLines).toEqual([])
    expect(told.map((note) => note.paneId)).toEqual(["p1", "p1"])
    expect(told[0]!.text).toContain("rifai la migrazione")
    expect(told[1]!.text).toContain("e poi i test")
  })

  /*
   * MOD2-5: where the gate says no line may go and no question is open, the message says
   * the pane isn't ready, rather than claiming a permission is open.
   */
  test("sendPrompt refuses where the gate says no line may go, with the not-ready message when no question is open (MOD2-5)", async () => {
    const writtenLines: string[] = []
    const { deps, told } = createMockDeps({
      isRunning: () => true,
      getRunningSession: () => ({ write: (line: string) => void writtenLines.push(line) }),
      permissions: () => ({}),
      questionOpen: () => false,
      isTyping: () => false,
      mayType: (id) => id !== "p1",
    })
    const host = createAdeVoiceHost(deps)

    await expect(host.sendPrompt("p1", "rifai la migrazione")).rejects.toThrow("il pannello non è pronto a ricevere testo; riprova tra poco")
    expect(writtenLines).toEqual([])
    expect(told.map((note) => note.paneId)).toEqual(["p1"])
    expect(told[0]!.text).toContain("il pannello non è pronto a ricevere testo")
    expect(told[0]!.text).toContain("rifai la migrazione")

    // English locale
    const hostEn = createAdeVoiceHost({ ...deps, locale: () => "en" })
    await expect(hostEn.sendPrompt("p1", "rifai la migrazione")).rejects.toThrow("that panel isn't ready for text yet; try again in a moment")

    await host.sendPrompt("p2", "rifai la migrazione")
    expect(writtenLines.length).toBe(1)
  })

  test("a line begun is told as a line begun, and not as a permission", async () => {
    const { deps } = createMockDeps({
      isRunning: () => true,
      getRunningSession: () => ({ write: () => {} }),
      permissions: () => ({}),
      isTyping: () => true,
      mayType: () => false,
    })
    await expect(createAdeVoiceHost(deps).sendPrompt("p1", "esegui i test")).rejects.toThrow("riga scritta a metà")
  })

  test("insertText into the terminal refuses too", async () => {
    const writtenLines: string[] = []
    const { deps } = createMockDeps({
      isRunning: (id) => id === "p1",
      getRunningSession: (id) => (id === "p1" ? { write: (line: string) => void writtenLines.push(line) } : undefined),
      permissions: () => ({ p1: asking }),
    })
    const host = createAdeVoiceHost(deps)
    await expect(host.insertText("p1", "sistema i test")).rejects.toThrow("permesso")
    expect(writtenLines).toEqual([])
  })
})

describe("the workbench's voice host", () => {
  const source = codeOf(workbenchSource())
  const call = source.slice(source.indexOf(codeOf("const voiceHost = createAdeVoiceHost({")))

  test("is told when the user has a line pending, by the rule the mail queue uses (MOD-2)", () => {
    expect(call.slice(0, 1500)).toContain(codeOf("isTyping: (id) => lineBegun(id),"))
  })

  test("asks the gate every line asks (review of ade/pronto, B5)", () => {
    expect(call.slice(0, 1500)).toContain(codeOf("mayType: (id) => mayType(id),"))
  })

  test("asks the workbench's own question gate, screen and hook included (B1)", () => {
    expect(call.slice(0, 1500)).toContain(codeOf("questionOpen: (id) => questionOpen(id),"))
  })

  test("passes typeLine dependency that delegates to typeLineOutcome (MOD2-2)", () => {
    expect(call.slice(0, 1500)).toContain(codeOf("typeLine:"))
  })
})

describe("MOD2-2: voice sendPrompt writes through typeLine and lineQueue", () => {
  test("sendPrompt delegates to deps.typeLine with unlessBusy: true and marks working on 'sent'", async () => {
    const typeLineCalls: { paneId: string; session: any; text: string; options?: any }[] = []
    const { deps, appendedLines, currentWb } = createMockDeps({
      isRunning: () => true,
      getRunningSession: (id) => ({ write: () => {} }),
      permissions: () => ({}),
      isTyping: () => false,
      mayType: () => true,
      typeLine: async (paneId, session, text, options) => {
        typeLineCalls.push({ paneId, session, text, options })
        return "sent"
      },
    })

    const host = createAdeVoiceHost(deps)
    deps.setWb((w) => ({ ...w, panes: [makePane({ id: "p1" })] }))
    await host.sendPrompt("p1", "fai il build")

    expect(typeLineCalls).toHaveLength(1)
    expect(typeLineCalls[0]!.paneId).toBe("p1")
    expect(typeLineCalls[0]!.text).toBe("fai il build")
    expect(typeLineCalls[0]!.options).toEqual({ unlessBusy: true })
    expect(appendedLines).toContainEqual({ paneId: "p1", text: "> fai il build", kind: "shell" })
    expect(currentWb().panes.find((p) => p.id === "p1")?.status).toBe("working")
  })

  test("B2: sendPrompt on typed-no-enter explains text is in box and Enter was not sent, without repeat", async () => {
    const { deps, appendedLines, currentWb, told } = createMockDeps({
      isRunning: () => true,
      getRunningSession: () => ({ write: () => {} }),
      permissions: () => ({}),
      isTyping: () => false,
      mayType: () => true,
      typeLine: async () => "typed-no-enter",
    })

    const host = createAdeVoiceHost(deps)
    await expect(host.sendPrompt("p1", "fai il build")).rejects.toThrow(
      "il testo è nella casella ma l'Invio non è partito; guarda il pannello, non ripetere",
    )
    expect(appendedLines).toHaveLength(0)
    expect(currentWb().panes.find((p) => p.id === "p1")?.status).not.toBe("working")
    expect(told).toHaveLength(1)
    expect(told[0]!.paneId).toBe("p1")
    expect(told[0]!.text).not.toContain("poi ripeti")
  })

  test("B2: sendPrompt on typed-no-enter in English explains text is in box and Enter was not sent, without repeat", async () => {
    const { deps, appendedLines, currentWb, told } = createMockDeps({
      isRunning: () => true,
      getRunningSession: () => ({ write: () => {} }),
      permissions: () => ({}),
      isTyping: () => false,
      mayType: () => true,
      typeLine: async () => "typed-no-enter",
      locale: () => "en",
    })

    const host = createAdeVoiceHost(deps)
    await expect(host.sendPrompt("p1", "build project")).rejects.toThrow(
      "the text is in the input box but Enter was not sent; check the panel, do not repeat",
    )
    expect(appendedLines).toHaveLength(0)
    expect(currentWb().panes.find((p) => p.id === "p1")?.status).not.toBe("working")
    expect(told).toHaveLength(1)
    expect(told[0]!.paneId).toBe("p1")
    expect(told[0]!.text).not.toContain("say it again")
  })

  test("B2: sendPrompt on not-typed when user is typing reports half-typed line", async () => {
    let isUserTyping = false
    const { deps, told } = createMockDeps({
      isRunning: () => true,
      getRunningSession: () => ({ write: () => {} }),
      permissions: () => ({}),
      isTyping: () => isUserTyping,
      mayType: () => true,
      typeLine: async () => {
        isUserTyping = true
        return "not-typed"
      },
    })

    const host = createAdeVoiceHost(deps)
    await expect(host.sendPrompt("p1", "fai il build")).rejects.toThrow("riga scritta a metà")
    expect(told[0]!.text).toContain("riga scritta a metà")
  })

  test("B2: sendPrompt on not-typed when question is open reports question/permission", async () => {
    let questionOpened = false
    const { deps, told } = createMockDeps({
      isRunning: () => true,
      getRunningSession: () => ({ write: () => {} }),
      permissions: () => ({}),
      questionOpen: () => questionOpened,
      mayType: () => true,
      typeLine: async () => {
        questionOpened = true
        return "not-typed"
      },
    })

    const host = createAdeVoiceHost(deps)
    await expect(host.sendPrompt("p1", "fai il build")).rejects.toThrow("permesso")
    expect(told[0]!.text).toContain("domanda")
  })

  test("B2: sendPrompt on not-typed when busy or not ready reports not-ready", async () => {
    const { deps, told } = createMockDeps({
      isRunning: () => true,
      getRunningSession: () => ({ write: () => {} }),
      permissions: () => ({}),
      isTyping: () => false,
      questionOpen: () => false,
      mayType: () => true,
      typeLine: async () => "not-typed",
    })

    const host = createAdeVoiceHost(deps)
    await expect(host.sendPrompt("p1", "fai il build")).rejects.toThrow(
      "il pannello non è pronto a ricevere testo; riprova tra poco",
    )
    expect(told[0]!.text).toContain("non è pronto")
  })

  test("mayType gate refuses before typeLine is even called", async () => {
    let typeLineCalled = false
    const { deps } = createMockDeps({
      isRunning: () => true,
      getRunningSession: (id) => ({ write: () => {} }),
      permissions: () => ({}),
      isTyping: () => false,
      mayType: () => false,
      typeLine: async () => {
        typeLineCalled = true
        return "sent"
      },
    })

    const host = createAdeVoiceHost(deps)
    await expect(host.sendPrompt("p1", "fai il build")).rejects.toThrow()
    expect(typeLineCalled).toBe(false)
  })
})
