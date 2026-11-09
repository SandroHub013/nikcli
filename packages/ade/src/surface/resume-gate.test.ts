import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * Review of ade/sessioni-salvataggi, B1 (UX-5): with the last project's folder gone, ADE opens on the empty project
 * screen and there is no open project. The block that restarts the saved sessions was gated on that project, so no
 * session came back in any project; a second later the autosave wrote them as not running, and the next start did not
 * resume them either. Each pane brings its own folder (`startProcess` finds its project and marks a missing folder), so
 * the block runs whenever there is a saved workspace.
 */
describe("the saved sessions are restarted whether or not a project is open (UX-5, review B1)", () => {
  // The workbench cannot be loaded under bun: read from the source. Booleans, so a failure does not print the file.
  const source = readFileSync(join(import.meta.dir, "workbench.tsx"), "utf8")

  test("the resume block is gated on the saved workspace only", () => {
    expect(source.includes("      if (restored) {\n")).toBe(true)
    expect(source.includes("if (restored && p) {")).toBe(false)
  })

  test("a pane's own folder is used when there is no open project", () => {
    expect(source.includes('const folder = pane.cwd || p?.root || pane.projectRoot || ""')).toBe(true)
    expect(source.includes("cwd: folder,")).toBe(true)
    expect(source.includes("conversationMissing(pane.agent, pane.resumeId, folder)")).toBe(true)
    expect(source.includes("cwd: pane.cwd || p.root,")).toBe(false)
  })
})
