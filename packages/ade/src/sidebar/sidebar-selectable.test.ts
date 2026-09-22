import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const sidebarCss = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8")
const indexCss = readFileSync(new URL("../index.css", import.meta.url), "utf8")
const sidebarTsx = readFileSync(new URL("./sidebar.tsx", import.meta.url), "utf8")

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "")

const ROW_SLOTS = [
  "workspace-header",
  "tree-row",
  "session-row",
  "active-agent-card",
  "file-result",
] as const

describe("sidebar hover and selection follow the form, not the slot name", () => {
  /*
   * The shell used to paint hover and the selection veil by listing five
   * slot names, so every new selectable row meant finding this list and
   * extending it. The rules now key on `data-selectable`, declared once in
   * the markup where the row is born; these assertions fail if anyone
   * re-lists the slots by name or removes the form attribute from a row.
   */
  test("the shell veil rules opt rows in through data-selectable", () => {
    const css = stripComments(sidebarCss)
    expect(css).toContain('[data-component="ade-sidebar"] [data-selectable]:hover')
    expect(css).toContain('[data-component="ade-sidebar"] [data-selectable][data-selected]')

    const oldHover = ['workspace-header', 'tree-row', 'session-row', 'active-agent-card']
    for (const slot of oldHover) {
      expect(css).not.toContain(`[data-component="ade-sidebar"] [data-slot="${slot}"]:hover`)
    }
    for (const slot of ROW_SLOTS) {
      const state = slot === 'workspace-header' ? 'data-active' : 'data-selected'
      expect(css).not.toContain(`[data-component="ade-sidebar"] [data-slot="${slot}"][${state}]`)
    }
  })

  test("every selectable row declares the form where it is born", () => {
    for (const slot of ROW_SLOTS) {
      const at = sidebarTsx.indexOf(`data-slot="${slot}"`)
      expect(at).toBeGreaterThanOrEqual(0)
      expect(sidebarTsx.slice(at, at + 240)).toContain("data-selectable")
    }
  })

  test("the active workspace carries the selection state the veil keys on", () => {
    const at = sidebarTsx.indexOf('data-slot="workspace-header"')
    expect(sidebarTsx.slice(at, at + 320)).toContain("data-selected")
  })

  /*
   * The `!important` pair existed only to silence the accent bar that
   * index.css drew for the selected session row from a rule written too
   * high in the cascade. The bar is now deleted rather than suppressed, so
   * nothing needs to win by force any more.
   */
  test("sidebar.css has no !important left to win the cascade by force", () => {
    expect(sidebarCss).not.toContain("!important")
  })

  test("the leading-edge bars are deleted, not suppressed", () => {
    for (const sheet of [stripComments(indexCss), stripComments(sidebarCss)]) {
      expect(sheet).not.toContain('[data-slot="session-row"][data-selected]::before')
      expect(sheet).not.toContain('[data-slot="tree-row"][data-selected]::before')
      expect(sheet).not.toContain('[data-slot="file-result"][data-selected]::before')
    }
  })
})
