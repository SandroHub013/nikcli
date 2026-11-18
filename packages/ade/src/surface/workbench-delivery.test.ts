import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { workbenchSource } from "../test-support/workbench-source"

/*
 * The workbench cannot be mounted under `bun test`, so the lines that deliver two fixes of the third live test live
 * here as lints on its source, and each is declared one. The helpers have tests of their own (`pane-title.test.ts`,
 * `sidebar/no-project.test.ts`); what no helper test can see is the caller that stops using them.
 */
const workbench = workbenchSource().replace(/\r\n/g, "\n")
const compact = (text: string) => text.replace(/\s+/g, " ")

describe("lint: FAIL 10, the default name of a pane is numbered within its project", () => {
  test("the one call of defaultPaneTitle passes the titles of the new pane's own project", () => {
    const calls = [...compact(workbench).matchAll(/defaultPaneTitle\(([^;]*?)\) setWb/g)]
    // The import is not a call; the call sits right before the `setWb` that adds the pane.
    expect(calls.length).toBe(1)
    expect(calls[0]![1]).toContain("titlesOfProject(wb().panes, {")
    expect(calls[0]![1]).toContain("workspaceId")
  })

  test("and nothing else in the workbench names a pane by hand with the launch's slot", () => {
    expect([...workbench.matchAll(/defaultPaneTitle\(/g)].length).toBe(1)
  })
})

describe("lint: FAIL 8, with no project the sidebar is told so and offers no new agent", () => {
  const start = workbench.indexOf("<Sidebar\n")
  const sidebar = workbench.slice(start, workbench.indexOf("/>", workbench.indexOf("footerActions=", start)))

  test("the Sidebar element is found", () => {
    expect(start).toBeGreaterThan(0)
    expect(sidebar).toContain("onSelectProject=")
  })

  test("it carries noProject for exactly the case where there is no project", () => {
    expect(sidebar).toContain("noProject={!project()}")
  })

  test("its onNewSession is conditional on a project, and no other line starts a session from it", () => {
    expect(sidebar).toMatch(/onNewSession=\{project\(\) \? \(\) => setStarting\(true\) : undefined\}/)
    expect([...sidebar.matchAll(/onNewSession=/g)].length).toBe(1)
  })
})

describe("lint: Fault 10, ade-msg not written reported to the page once", () => {
  test("workbench checks mailboxInstallError at startup and reports it with mail.adeMsgFailed", () => {
    expect(workbench).toContain("mailboxInstallError")
    expect(workbench).toContain("mail.adeMsgFailed")
  })
})

