import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
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
