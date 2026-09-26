import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
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
