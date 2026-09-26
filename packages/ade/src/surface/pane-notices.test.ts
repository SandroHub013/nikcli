import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { readReportLine } from "../session/report"
import { join } from "node:path"
import { translate } from "../i18n"
import { MAX_NOTICES, addPane, createWorkbench, toWorkspaceState, withPaneNotice, type Pane } from "./state"

/*
 * Prove dal vivo 2, difetto A: the restore's notes («già aperta», «aperta
 * anche», another folder) were written to the transcript, which a pane with a
 * live terminal hides, so nobody read them.
 */

const read = (...path: string[]) => readFileSync(join(import.meta.dir, "..", ...path), "utf8")

describe("the notes over a terminal", () => {
  test("are the latest few, the same one once", () => {
    let notices = withPaneNotice(undefined, "uno")
    notices = withPaneNotice(notices, "due")
    notices = withPaneNotice(notices, "uno")
    expect(notices).toEqual(["due", "uno"])
    for (const text of ["tre", "quattro", "cinque"]) notices = withPaneNotice(notices, text)
    expect(notices).toHaveLength(MAX_NOTICES)
    expect(notices.at(-1)).toBe("cinque")
  })

  test("are shown over the terminal, where the transcript is hidden, and can be dismissed", () => {
    const pane = read("grid", "pane.tsx")
    expect(pane).toContain('<Show when={props.terminalId && props.notices?.length ? props.notices : undefined}>')
    expect(pane).toContain('data-slot="pane-notice"')
    expect(pane).toContain("props.onDismissNotices?.()")
    const renderer = read("surface", "pane-renderer.tsx")
    expect(renderer).toContain("notices={current().notices}")
    expect(renderer).toContain("onDismissNotices={() => deps.dismissNotices(current().id)}")
  })

  test("carry every note of the restore, and none of them only in the transcript", () => {
    const workbench = read("surface", "workbench.tsx")
    for (const key of ["resume.shared", "resume.alsoOpen", "resume.otherFolder", "resume.noneHere", "resume.none", "resume.noMint"]) {
      expect(workbench).toMatch(new RegExp(`tellPane\\([^\\n]*t\\("${key.replace(".", "\\.")}"`))
      expect(workbench).not.toMatch(new RegExp(`appendLine\\([^\\n]*t\\("${key.replace(".", "\\.")}"`))
    }
  })

  test("are not saved with the workspace", () => {
    const pane: Pane = { id: "p1", title: "T", status: "idle", model: "nikcli", mode: "auto", lines: [], workspaceId: "w1", notices: ["nota da non salvare"] }
    const saved = JSON.stringify(toWorkspaceState(addPane(createWorkbench(), pane)))
    expect(saved).not.toContain("nota da non salvare")
  })

  test("«già aperta» does not promise a new conversation: the pane may reopen one of its folder", () => {
    expect(translate("it", "resume.shared", "Sessione 1")).not.toContain("ne parte un'altra")
    expect(translate("it", "resume.shared", "Sessione 1")).toContain("qui non la riapro")
    expect(translate("en", "resume.shared", "Sessione 1")).not.toContain("another one starts")
  })
})

/*
 * Verifiche, live 4: after a restore «here» the pane's header stayed on «Cerco
 * l'ultima conversazione di nikcli» with the conversation found and open. The
 * header shows the agent's reported activity, and ADE's own note read as one.
 */
describe("ADE's own notes are not the agent's report", () => {
  test("the note reads as an activity, which is why it must not be read", () => {
    const note = "Cerco l'ultima conversazione di nikcli in questa cartella…"
    expect(readReportLine({}, note).activity).toBeDefined()
  })

  test("the restore's notes and the pane notices are written as ADE's", () => {
    const workbench = read("surface", "workbench.tsx")
    expect(workbench).toContain('if (from === "ade") return')
    expect(workbench).toContain('appendLine(paneId, t("resume.lookingHere", agent.label || agentId), "note", "ade")')
    expect(workbench).toContain('appendLine(paneId, t("resume.asking", agent.label || agentId), "note", "ade")')
    expect(workbench).toContain('appendLine(id, text, "note", "ade")')
    // The report and the permission watch come after the line is kept, and only for the agent's.
    const body = workbench.slice(workbench.indexOf("const appendLine = "), workbench.indexOf("const watchForPermission = "))
    expect(body.indexOf('if (from === "ade") return')).toBeLessThan(body.indexOf("watchForPermission(id, text)"))
    expect(body.indexOf('if (from === "ade") return')).toBeLessThan(body.indexOf("readReportLine"))
  })

  test("a note that carries another session's words is still ADE's", () => {
    const workbench = read("surface", "workbench.tsx")
    // A message, a reply, an update, a memory line: another session's text, in a note ADE writes.
    for (const key of ["note.messageFrom", "note.replyFrom", "note.updateFrom", "note.memory"]) {
      const calls = workbench.split("\n").filter((line) => line.includes("appendLine(") && line.includes(`"${key}"`))
      expect([key, calls.length > 0, calls.every((line) => line.trimEnd().endsWith('"note", "ade")'))]).toEqual([key, true, true])
    }
    // And no note of ADE's is left to be read as the agent's report.
    const agentNotes = workbench.split("\n").filter((line) => /appendLine\(.*"note"\)+$/.test(line.trimEnd()))
    expect(agentNotes).toEqual([])
  })
})

/*
 * The general rule (note-pannelli): a note of ADE's that is an error, or
 * something the user has to do or know, goes over the terminal too. A pane's
 * terminal stays live from its first output until the pane is closed, so a
 * suspended, exited or restarted pane hides its transcript as well; and a
 * line written into xterm is wiped by the agent's next redraw.
 */
describe("the notes that go over the terminal", () => {
  const workbench = read("surface", "workbench.tsx")
  const lines = workbench.split("\n")
  const told = (key: string) => lines.filter((line) => line.includes(`"${key}"`) && /tellPane\(|\bsay\(/.test(line))
  const onlyWritten = (key: string) => lines.filter((line) => line.includes(`"${key}"`) && line.includes("appendLine("))

  test("errors, and what the user has to do, are told, not only written", () => {
    const keys = [
      "pane.startFailed",
      "pane.connectFailed",
      "keys.unread",
      "task.notSent",
      "task.stepNotSent",
      "note.suspendRefused",
      "note.suspendKillFailed",
      "note.resumeFailed",
      "pane.maybeStuck",
      "note.interruptedBy",
      "note.restartedFresh",
      "note.browserRequest",
    ]
    for (const key of keys) {
      expect([key, told(key).length > 0, onlyWritten(key)]).toEqual([key, true, []])
    }
    // The failed auto-close is told; the one that closed is only written.
    expect(workbench).toContain('const say = "error" in outcome ? tellPane : (id: string, text: string) => appendLine(id, text, "note", "ade")')
  })

  test("a start that failed says why, and no bare error goes to the transcript alone", () => {
    expect(workbench).toContain('tellPane(paneId, t("pane.startFailed", String(e)))')
    expect(workbench).toContain('tellPane(paneId, t("pane.connectFailed", String(e)))')
    expect(workbench).not.toMatch(/appendLine\(paneId, String\(e\)\)/)
  })

  test("nothing is written into the terminal itself, where the agent's redraw wipes it", () => {
    expect(workbench).not.toContain("noteInTerminal(")
    expect(workbench).toContain("const say = (text: string) => tellPane(paneId, text)")
  })

  test("the drop with nobody listening and the spoken «no» with no refusal are told", () => {
    const renderer = read("surface", "pane-renderer.tsx")
    expect(renderer).toContain('deps.tellPane(current().id, t("pane.notDelivered", text))')
    expect(workbench).toMatch(/\n    tellPane,\n/)
    const host = read("voice", "host.ts")
    expect(host).toContain('if (answer === "deny") deps.tellPane(paneId, t("voice.permission.notRefusal"))')
    expect(workbench).toContain("tellPane: (id, text) => tellPane(id, text),")
  })

  test("the traffic between sessions stays in the transcript: over the terminal it would never leave", () => {
    const traffic = [
      "note.askFrom",
      "note.askTo",
      "note.messageFrom",
      "note.messageTo",
      "note.replyFrom",
      "note.replySentTo",
      "note.updateFrom",
      "note.viaNative",
      "note.viaNativeAck",
      "note.viaTyped",
      "note.viaFallback",
      "note.rang",
      "note.nudged",
      "note.resent",
      "note.resentRequest",
      "note.enterHeld",
      "note.inboxLost",
      "note.subagent",
      "note.memory",
      "resume.lookingHere",
      "resume.asking",
      "keys.passed",
      "note.suspended",
    ]
    for (const key of traffic) expect([key, told(key)]).toEqual([key, []])
  })
})
