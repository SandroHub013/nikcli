import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { acceptsReport, parseReport } from "./agent-link"
import { NIKCLI_PLUGIN_NAME, NIKCLI_PLUGIN_SOURCE } from "./nikcli-plugin"
import { HOOK_MARKER } from "./agent-hooks"

/** The text Rust compiles in and writes. */
const nikcliPluginScript = () => readFileSync(new URL(NIKCLI_PLUGIN_SOURCE, import.meta.url), "utf8")

/*
 * The plugin as nikcli's TUI loads it: the file ADE writes, imported, its
 * default export's `tui` called with an `api`. Here the `api` is a stand-in
 * with the three things the plugin reads — the route, the session's folder,
 * the dispose hook — and the report lands in a real folder.
 */

const ENV = ["ADE_PANE_ID", "ADE_SPAWN_NONCE", "ADE_SESSION_DIR"] as const
const dirs: string[] = []
const disposers: (() => void)[] = []
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]))

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function loadPlugin() {
  const dir = mkdtempSync(join(tmpdir(), "ade-nikcli-plugin-"))
  dirs.push(dir)
  const file = join(dir, NIKCLI_PLUGIN_NAME)
  writeFileSync(file, nikcliPluginScript())
  const module = (await import(pathToFileURL(file).href)) as { default: { id: string; tui: (api: unknown, options?: unknown) => Promise<void> } }
  return module.default
}

function fakeTui(sessions: Record<string, { directory: string; parentID?: string }>) {
  let route: { name: string; params?: Record<string, unknown> } = { name: "home" }
  const api = {
    route: {
      get current() {
        return route
      },
    },
    client: { session: { get: async ({ sessionID }: { sessionID: string }) => ({ data: { id: sessionID, ...sessions[sessionID] } }) } },
    lifecycle: { onDispose: (fn: () => void) => (disposers.push(fn), () => {}) },
  }
  return { api, show: (sessionID: string) => void (route = { name: "session", params: { sessionID } }), home: () => void (route = { name: "home" }) }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40))

function launchedByAde() {
  const drop = mkdtempSync(join(tmpdir(), "ade-nikcli-drop-"))
  dirs.push(drop)
  process.env.ADE_PANE_ID = "pane-3"
  process.env.ADE_SPAWN_NONCE = "a1b2c3d4e5f6a1b2c3d4e5f6"
  process.env.ADE_SESSION_DIR = drop
  return { drop, report: join(drop, "a1b2c3d4e5f6a1b2c3d4e5f6.json") }
}

describe("nikcli's TUI plugin", () => {
  test("is a module the TUI loads: a default export with an id and tui()", async () => {
    const plugin = await loadPlugin()
    expect(plugin.id).toBe(HOOK_MARKER)
    expect(NIKCLI_PLUGIN_NAME).toBe(`${HOOK_MARKER}.js`)
    expect(typeof plugin.tui).toBe("function")
    // No package imports: only Node's own modules.
    const imports = [...nikcliPluginScript().matchAll(/from "([^"]+)"/g)].map((match) => match[1])
    expect(imports.every((name) => name!.startsWith("node:"))).toBe(true)
  })

  test("a conversation on screen is reported with the protocol ADE reads, then each one it changes to", async () => {
    const plugin = await loadPlugin()
    const { drop, report } = launchedByAde()
    const tui = fakeTui({ ses_one: { directory: "C:\\p" }, ses_two: { directory: "C:\\altro" } })
    tui.show("ses_one")
    await plugin.tui(tui.api, { intervalMs: 5 })
    await settle()
    const first = parseReport(readFileSync(report, "utf8"))!
    expect(first).toMatchObject({ pane: "pane-3", agent: "nikcli", sessionId: "ses_one", source: "switch", sessionDir: "C:\\p" })
    expect(acceptsReport(first, { pane: "pane-3", nonce: "a1b2c3d4e5f6a1b2c3d4e5f6" })).toBe(true)

    tui.show("ses_two")
    await settle()
    expect(parseReport(readFileSync(report, "utf8"))).toMatchObject({ sessionId: "ses_two", sessionDir: "C:\\altro" })
    // Moved into place whole: nothing half-written is left beside it.
    expect(readdirSync(drop)).toEqual(["a1b2c3d4e5f6a1b2c3d4e5f6.json"])
  })

  test("the same conversation is not written again, the home screen and a child conversation not at all", async () => {
    const plugin = await loadPlugin()
    const { report } = launchedByAde()
    const tui = fakeTui({ ses_one: { directory: "C:\\p" }, ses_child: { directory: "C:\\p", parentID: "ses_one" } })
    await plugin.tui(tui.api, { intervalMs: 5 })
    await settle()
    expect(existsSync(report)).toBe(false)
    tui.show("ses_one")
    await settle()
    unlinkSync(report)
    await settle()
    expect(existsSync(report)).toBe(false)
    tui.show("ses_child")
    await settle()
    expect(existsSync(report)).toBe(false)
  })

  test("a TUI ADE did not start is left alone: no report, no timer", async () => {
    const plugin = await loadPlugin()
    const { drop } = launchedByAde()
    delete process.env.ADE_SPAWN_NONCE
    const tui = fakeTui({ ses_one: { directory: "C:\\p" } })
    tui.show("ses_one")
    await plugin.tui(tui.api, { intervalMs: 5 })
    await settle()
    expect(readdirSync(drop)).toEqual([])
    expect(disposers).toHaveLength(0)
  })

  test("a nonce that is not hex never becomes a file name", async () => {
    const plugin = await loadPlugin()
    const { drop } = launchedByAde()
    process.env.ADE_SPAWN_NONCE = "..\\..\\x"
    const tui = fakeTui({ ses_one: { directory: "C:\\p" } })
    tui.show("ses_one")
    await plugin.tui(tui.api, { intervalMs: 5 })
    await settle()
    expect(readdirSync(drop)).toEqual([])
  })
})
