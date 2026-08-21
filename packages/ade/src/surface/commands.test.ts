import { describe, expect, test } from "bun:test"
import { buildCommands, type CommandContext } from "./commands"
import { createWorkbench, type Pane, type Workbench } from "./state"

function context(overrides: Partial<CommandContext> & { workbench: Workbench }): CommandContext {
  return {
    recents: [],
    hasHost: true,
    running: new Set<string>(),
    platform: "other",
    ...overrides,
  }
}

function pane(overrides: Partial<Pane> = {}): Pane {
  return {
    id: "p1",
    title: "Test",
    status: "working",
    model: "agy",
    mode: "auto",
    lines: [],
    workspaceId: "ws1",
    ...overrides,
  }
}

describe("surface commands", () => {
  test("offers starting a session, and says why closing is unavailable", () => {
    const cmds = buildCommands(context({ workbench: createWorkbench() }))

    expect(cmds.find((c) => c.id === "session.new")).toBeDefined()

    const close = cmds.find((c) => c.id === "pane.close")
    expect(close?.enabled).toBe(false)
    expect(close?.disabledReason).toBe("Nessun pannello a fuoco")
  })

  test("a focused pane enables the pane commands", () => {
    const wb = createWorkbench()
    wb.panes.push(pane())
    wb.focusedId = "p1"

    const cmds = buildCommands(context({ workbench: wb }))

    expect(cmds.find((c) => c.id === "pane.close")?.enabled).toBe(true)
    expect(cmds.find((c) => c.id === "pane.expand")?.enabled).toBe(true)
  })

  /*
   * The distinction the old version got wrong: a pane that is not a browser is
   * not the same as a pane with a live process. Killing what has already exited
   * is a command that can only disappoint.
   */
  test("killing is offered only when the focused pane has a live process", () => {
    const wb = createWorkbench()
    wb.panes.push(pane())
    wb.focusedId = "p1"

    const idle = buildCommands(context({ workbench: wb }))
    expect(idle.find((c) => c.id === "process.kill")?.enabled).toBe(false)

    const live = buildCommands(context({ workbench: wb, running: new Set(["p1"]) }))
    expect(live.find((c) => c.id === "process.kill")?.enabled).toBe(true)
  })

  test("without a host, the commands that need the disk say so", () => {
    const cmds = buildCommands(context({ workbench: createWorkbench(), hasHost: false }))

    const open = cmds.find((c) => c.id === "project.open")
    expect(open?.enabled).toBe(false)
    expect(open?.disabledReason).toBe("Richiede l'app desktop")
  })

  test("shortcuts come from the keymap rather than from prose", () => {
    const cmds = buildCommands(context({ workbench: createWorkbench() }))

    // Bound in DEFAULT_BINDINGS as mod+w, which is Ctrl on this platform.
    expect(cmds.find((c) => c.id === "pane.close")?.shortcut).toBe("Ctrl+W")
    // Not bound to anything, so it must not claim a key.
    expect(cmds.find((c) => c.id === "browser.new")?.shortcut).toBeUndefined()
  })

  test("recent projects become commands of their own", () => {
    const cmds = buildCommands(
      context({
        workbench: createWorkbench(),
        recents: [{ name: "Nikcli", root: "/path", openedAt: 123 }],
      }),
    )

    const recent = cmds.find((c) => c.id.startsWith("project.recent."))
    expect(recent?.title).toBe("Nikcli")
    expect(recent?.description).toBe("/path")
  })
})
