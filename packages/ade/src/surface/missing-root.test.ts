import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { withMissing, withoutMissing } from "../host/recent"
import { t } from "../i18n"
import { buildCommands, type CommandContext } from "./commands"
import { createWorkbench, deriveWorkspaces } from "./state"

/*
 * A saved project whose folder is gone (ROADMAP, BASSO): marked in the
 * sidebar's Spaces and in the palette, never removed on its own; opening it
 * says so and offers «Togli dall'elenco».
 */

test("the notice names the folder and the one way out", () => {
  expect(t("project.missing", "C:/x/nikcli-ade-vecchia")).toBe("La cartella C:/x/nikcli-ade-vecchia non esiste più.")
  expect(t("project.missing.remove")).toBe("Togli dall'elenco")
})

test("a Space whose folder is gone is marked, and stays in the list", () => {
  const spaces = deriveWorkspaces([], [
    { root: "C:/x/nikcli", name: "nikcli" },
    { root: "C:/x/nikcli-ade-vecchia", name: "nikcli-ade-vecchia", missing: true },
  ])
  expect(spaces.map((space) => [space.name, space.missing ?? false])).toEqual([
    ["nikcli", false],
    ["nikcli-ade-vecchia", true],
  ])
  const css = readFileSync(join(import.meta.dir, "../sidebar/sidebar.css"), "utf-8")
  expect(css).toContain('[data-slot="workspace-header"][data-missing="true"] [data-slot="workspace-name"]')
})

test("the palette still offers a gone project, saying it is gone", () => {
  const context = {
    workbench: createWorkbench(),
    recents: [
      { name: "vecchia", root: "C:/x/nikcli-ade-vecchia", openedAt: 2 },
      { name: "nikcli", root: "C:/x/nikcli", openedAt: 1 },
    ],
    missingRecent: (root: string) => root.endsWith("vecchia"),
    hasHost: true,
    running: new Set<string>(),
    platform: "windows",
  } as unknown as CommandContext
  const recent = buildCommands(context).filter((command) => command.id.startsWith("project.recent."))
  expect(recent.map((command) => [command.title, command.description, command.enabled])).toEqual([
    ["vecchia", "Cartella sparita · C:/x/nikcli-ade-vecchia", true],
    ["nikcli", "C:/x/nikcli", true],
  ])
})

describe("the gone folders, all at once (the Architect, BASSO)", () => {
  const base = {
    recents: [
      { name: "a", root: "C:/x/nikcli-ade-a", openedAt: 3 },
      { name: "b", root: "C:/x/nikcli-ade-b", openedAt: 2 },
      { name: "nikcli", root: "C:/x/nikcli", openedAt: 1 },
    ],
    hasHost: true,
    running: new Set<string>(),
    platform: "windows",
  }
  const pane = (id: string, gone?: string) => ({ id, title: id, status: "error", lines: [], workspaceId: "w", ...(gone ? { gone } : {}) })
  const commandsOf = (extra: Record<string, unknown>) =>
    buildCommands({ ...base, workbench: createWorkbench(), ...extra } as unknown as CommandContext)

  test("offered only when something is gone", () => {
    const ids = commandsOf({ missingRecent: () => false }).map((command) => command.id)
    expect(ids).not.toContain("panes.closeGone")
    expect(ids).not.toContain("recents.forgetGone")
  })

  test("they say how many: panes whose folder is gone and not running, recents marked gone", () => {
    const workbench = { ...createWorkbench(), panes: [pane("p1", "C:/x/nikcli-ade-a"), pane("p2", "C:/x/nikcli-ade-b"), pane("p3"), pane("p4", "C:/x/c")] }
    const commands = commandsOf({ workbench, running: new Set(["p4"]), missingRecent: (root: string) => root.includes("nikcli-ade-") })
    expect(commands.find((command) => command.id === "panes.closeGone")?.title).toBe("Chiudi i pannelli delle cartelle sparite (2)")
    expect(commands.find((command) => command.id === "recents.forgetGone")?.title).toBe("Togli dai recenti le cartelle sparite (2)")
  })

  test("the confirmation says how many, and the removal leaves the others", () => {
    expect(t("confirm.forgetGone", 68)).toBe("Togliere dai recenti e dagli Spaces 68 cartelle sparite?")
    expect(t("confirm.forgetGone", 1)).toBe("Togliere dai recenti e dagli Spaces 1 cartella sparita?")
    const gone = withMissing(withMissing(new Set(), "C:/x/nikcli-ade-a", true), "C:\\x\\nikcli-ade-b", true)
    expect(withoutMissing(base.recents, gone).map((entry) => entry.name)).toEqual(["nikcli"])
  })
})
