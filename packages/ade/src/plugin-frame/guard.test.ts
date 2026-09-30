/**
 * The three guards of T2: what must stay true whatever the plugin host grows into.
 *
 * 1. `plugin-frame/` does not import from `nikverse/`: NikVerse stays on its own panel until T3, and T3 deletes its copies. If the host
 *    imported it, deleting them would break the host.
 * 2. The loader of plugins that live in the project stays shut: T2 opens the frame for the plugins ADE installs and signs, not for a file the
 *    project declares (choice 2a of the plan).
 * 3. A layout restored with the panel of a plugin that is not installed shows its placeholder.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { createActivation } from "./activation"
import { parseWorkspace, serializeWorkspace } from "../session/persist"
import { FILE_PLUGINS_DISABLED, FILE_PLUGIN_DISABLED_REASON, importPluginModule } from "../plugin/loader"
import { addPane, createWorkbench, fromWorkspaceState, toWorkspaceState, type Pane } from "../surface/state"

const dir = import.meta.dir

function sources(from: string): string[] {
  return readdirSync(from).flatMap((name) => {
    const full = join(from, name)
    if (statSync(full).isDirectory()) return name === "fixtures" ? [] : sources(full)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : []
  })
}

describe("plugin-frame does not depend on nikverse", () => {
  test("no file of plugin-frame imports from nikverse/, and none names the module", () => {
    const files = sources(dir)
    expect(files.length).toBeGreaterThan(8)
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      const imports = [...text.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((match) => match[1]!)
      expect([file, imports.filter((path) => /nikverse/i.test(path))]).toEqual([file, []])
    }
  })

  test("the tests of plugin-frame do not import from nikverse/ either, so deleting it in T3 leaves them standing", () => {
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".test.ts") && file !== "guard.test.ts")) {
      const text = readFileSync(join(dir, name), "utf8")
      const imports = [...text.matchAll(/from\s*["']([^"']+)["']/g)].map((match) => match[1]!)
      expect([name, imports.filter((path) => /nikverse/i.test(path))]).toEqual([name, []])
    }
  })

  test("the frame fixtures and the scheme they are served under do not name nikverse", () => {
    const fixtures = join(dir, "fixtures", "hello-plugin")
    for (const name of readdirSync(fixtures)) {
      expect([name, /nikverse/i.test(readFileSync(join(fixtures, name), "utf8"))]).toEqual([name, false])
    }
  })
})

describe("the loader of plugins that live in the project is still shut", () => {
  test("file plugins are disabled, and importing one is refused with the reason", async () => {
    expect(FILE_PLUGINS_DISABLED).toBe(true)
    await expect(importPluginModule("file:///C:/repo/p.js")).rejects.toThrow(FILE_PLUGIN_DISABLED_REASON)
  })

  test("the frame host does not reach for the loader, and the loader does not know the frame host", () => {
    const loader = readFileSync(join(dir, "..", "plugin", "loader.ts"), "utf8")
    expect(loader).not.toMatch(/plugin-frame/)
    for (const file of sources(dir)) {
      const text = readFileSync(file, "utf8")
      expect([file, /from\s*["'][^"']*plugin\/loader["']/.test(text)]).toEqual([file, false])
    }
  })

  test("the panel of a frame plugin does not read `pane.plugin`, which is the plugins that draw in ADE's own DOM", () => {
    for (const file of sources(dir).filter((name) => name.endsWith(".tsx"))) {
      const text = readFileSync(file, "utf8")
      expect([file, /\b(?:pane|current\(\))\.plugin\b/.test(text)]).toEqual([file, false])
    }
  })
})

describe("a layout restored with a plugin that is not installed shows the placeholder", () => {
  const panel: Pane = {
    id: "fp-1",
    title: "Hello",
    status: "working",
    model: "—",
    mode: "plugin-frame",
    framePlugin: { id: "hello" },
    workspaceId: "nikcli",
    projectRoot: "C:/work/nikcli",
    lines: [],
  }

  test("the panel is saved, and comes back as a panel and not as a session", () => {
    const state = toWorkspaceState(addPane(createWorkbench(), panel))
    expect(state.panes).toEqual([])
    expect(state.framePlugins).toEqual([{ id: "fp-1", plugin: "hello", title: "Hello", project: "nikcli", projectRoot: "C:/work/nikcli" }])
    const restored = fromWorkspaceState(parseWorkspace(serializeWorkspace(state))!)
    expect(restored.panes).toHaveLength(1)
    expect(restored.panes[0]).toMatchObject({ id: "fp-1", mode: "plugin-frame", framePlugin: { id: "hello" }, workspaceId: "nikcli" })
  })

  test("with the plugin absent the restored panel is the placeholder: nothing installed, nothing committed, nothing loaded", async () => {
    const restored = fromWorkspaceState(parseWorkspace(serializeWorkspace(toWorkspaceState(addPane(createWorkbench(), panel))))!)
    const calls: string[] = []
    const activation = createActivation(restored.panes[0]!.framePlugin!.id, {
      list: async () => undefined,
      commit: async () => (calls.push("commit"), ""),
      rollback: async () => (calls.push("rollback"), ""),
      accepted: () => [],
      accept: () => calls.push("accept"),
      rejected: { add: () => calls.push("reject") },
      schedule: () => (calls.push("schedule"), () => {}),
      phase: () => {},
    })
    await activation.open()
    expect(activation.phase()).toEqual({ kind: "absent" })
    expect(calls).toEqual([])
  })

  test("a saved state with no plugin panel carries no key for it, so an older build reads it as before", () => {
    const state = toWorkspaceState(createWorkbench())
    expect("framePlugins" in state).toBe(false)
    expect(serializeWorkspace(state)).not.toContain("framePlugins")
  })

  test("what the store cannot vouch for is dropped: no id, an id the native side would refuse, a path, something that is not an object", () => {
    const json = (framePlugins: unknown) => JSON.stringify({ version: 4, panes: [], framePlugins })
    const kept = (framePlugins: unknown) => parseWorkspace(json(framePlugins))?.framePlugins ?? []
    expect(kept([{ id: "a", plugin: "hello", title: "Hello" }])).toEqual([{ id: "a", plugin: "hello", title: "Hello" }])
    for (const entry of [
      null,
      "hello",
      [],
      {},
      { id: "a" },
      { plugin: "hello" },
      { id: "", plugin: "hello" },
      { id: "a", plugin: "../hello" },
      { id: "a", plugin: "Hello" },
      { id: "a", plugin: "a/b" },
      { id: "a", plugin: "hello:evil" },
      { id: "a", plugin: 3 },
    ]) {
      expect([entry, kept([entry])]).toEqual([entry, []])
    }
    expect(kept("nope")).toEqual([])
    expect(kept({})).toEqual([])
  })

  test("a session saved in the same state is not touched by the panels around it", () => {
    let wb = addPane(createWorkbench(), panel)
    wb = addPane(wb, {
      id: "s1",
      title: "Dario",
      status: "working",
      model: "claude-code",
      agent: "claude-code",
      mode: "—",
      workspaceId: "nikcli",
      lines: [],
    })
    const state = toWorkspaceState(wb)
    expect(state.panes.map((saved) => saved.id)).toEqual(["s1"])
    expect(state.framePlugins?.map((saved) => saved.id)).toEqual(["fp-1"])
  })
})
