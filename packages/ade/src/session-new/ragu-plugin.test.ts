import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseActivity } from "../session/mailbox"
import { acceptsReport, parseReport } from "./agent-link"
import { RAGU_PLUGIN_NAME, RAGU_PLUGIN_SOURCE } from "./ragu-plugin"
import { HOOK_MARKER } from "./agent-hooks"

/** The text Rust compiles in and writes. */
const raguPluginScript = () => readFileSync(new URL(RAGU_PLUGIN_SOURCE, import.meta.url), "utf8")

/*
 * The plugin as ragu's TUI loads it: the file ADE writes, imported, its
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
  const dir = mkdtempSync(join(tmpdir(), "ade-ragu-plugin-"))
  dirs.push(dir)
  const file = join(dir, RAGU_PLUGIN_NAME)
  writeFileSync(file, raguPluginScript())
  const module = (await import(pathToFileURL(file).href)) as {
    default: { id: string; tui: (api: unknown, options?: unknown) => Promise<void> }
  }
  return module.default
}

function fakeTui(
  sessions: Record<string, { directory: string; parentID?: string }>,
  abort: (args: { sessionID: string }) => Promise<unknown> = async () => ({ data: true }),
) {
  let route: { name: string; params?: Record<string, unknown> } = { name: "home" }
  const api = {
    route: {
      get current() {
        return route
      },
    },
    client: {
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({ data: { id: sessionID, ...sessions[sessionID] } }),
        abort,
      },
    },
    lifecycle: { onDispose: (fn: () => void) => (disposers.push(fn), () => {}) },
  }
  return {
    api,
    show: (sessionID: string) => void (route = { name: "session", params: { sessionID } }),
    home: () => void (route = { name: "home" }),
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40))

function launchedByAde() {
  const drop = mkdtempSync(join(tmpdir(), "ade-ragu-drop-"))
  dirs.push(drop)
  process.env.ADE_PANE_ID = "pane-3"
  process.env.ADE_SPAWN_NONCE = "a1b2c3d4e5f6a1b2c3d4e5f6"
  process.env.ADE_SESSION_DIR = drop
  return { drop, report: join(drop, "a1b2c3d4e5f6a1b2c3d4e5f6.json") }
}

describe("ragu's TUI plugin", () => {
  test("is a module the TUI loads: a default export with an id and tui()", async () => {
    const plugin = await loadPlugin()
    expect(plugin.id).toBe(HOOK_MARKER)
    expect(RAGU_PLUGIN_NAME).toBe(`${HOOK_MARKER}.js`)
    expect(typeof plugin.tui).toBe("function")
    // No package imports: only Node's own modules.
    const imports = [...raguPluginScript().matchAll(/from "([^"]+)"/g)].map((match) => match[1])
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
    expect(first).toMatchObject({
      pane: "pane-3",
      agent: "ragu",
      sessionId: "ses_one",
      source: "switch",
      sessionDir: "C:\\p",
    })
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

  describe("the turn it reports (what ADE used to guess from the terminal going quiet)", () => {
    const activityOf = (drop: string) => {
      const file = join(drop, "a1b2c3d4e5f6a1b2c3d4e5f6.activity")
      return existsSync(file) ? parseActivity(readFileSync(file, "utf8")) : undefined
    }
    function withState() {
      const status: Record<string, { type: string }> = {}
      const permission: Record<string, unknown[]> = {}
      const question: Record<string, unknown[]> = {}
      const tui = fakeTui({ ses_one: { directory: "C:\\p" }, ses_child: { directory: "C:\\p", parentID: "ses_one" } })
      ;(tui.api as Record<string, unknown>).state = {
        session: {
          status: (id: string) => status[id],
          permission: (id: string) => permission[id] ?? [],
          question: (id: string) => question[id] ?? [],
        },
      }
      return { tui, status, permission, question }
    }

    test("busy while the TUI says it is working, idle when it is not, from the conversation on screen", async () => {
      const plugin = await loadPlugin()
      const { drop } = launchedByAde()
      const { tui, status } = withState()
      tui.show("ses_one")
      await plugin.tui(tui.api, { intervalMs: 5 })
      await settle()
      expect(activityOf(drop)).toMatchObject({ state: "idle", cwd: "C:\\p" })
      status.ses_one = { type: "busy" }
      await settle()
      expect(activityOf(drop)?.state).toBe("busy")
      status.ses_one = { type: "retry" }
      await settle()
      expect(activityOf(drop)?.state).toBe("busy")
      status.ses_one = { type: "idle" }
      await settle()
      expect(activityOf(drop)?.state).toBe("idle")
    })

    test("a permission or a question waiting is a permission: ADE types nothing into it", async () => {
      const plugin = await loadPlugin()
      const { drop } = launchedByAde()
      const { tui, status, permission, question } = withState()
      tui.show("ses_one")
      status.ses_one = { type: "busy" }
      await plugin.tui(tui.api, { intervalMs: 5 })
      await settle()
      permission.ses_one = [{ id: "p1" }]
      await settle()
      expect(activityOf(drop)?.state).toBe("permission")
      permission.ses_one = []
      question.ses_one = [{ id: "q1" }]
      await settle()
      expect(activityOf(drop)?.state).toBe("permission")
      question.ses_one = []
      await settle()
      expect(activityOf(drop)?.state).toBe("busy")
    })

    test("written when it changes, not on every tick, and never for a child conversation", async () => {
      const plugin = await loadPlugin()
      const { drop } = launchedByAde()
      const { tui } = withState()
      tui.show("ses_one")
      await plugin.tui(tui.api, { intervalMs: 5 })
      await settle()
      const first = activityOf(drop)!
      await settle()
      expect(activityOf(drop)!.at).toBe(first.at)
      tui.show("ses_child")
      await settle()
      expect(activityOf(drop)).toEqual(first)
    })

    test("a TUI without the state writes no activity at all: ADE keeps guessing", async () => {
      const plugin = await loadPlugin()
      const { drop } = launchedByAde()
      const tui = fakeTui({ ses_one: { directory: "C:\\p" } })
      tui.show("ses_one")
      await plugin.tui(tui.api, { intervalMs: 5 })
      await settle()
      expect(existsSync(join(drop, "a1b2c3d4e5f6a1b2c3d4e5f6.activity"))).toBe(false)
    })
  })

  /*
   * ragu-pannelli-0211: `ade-msg interrupt` writes `<nonce>.interrupt` (Rust, `agent_interrupt`) and waits for it to go.
   * The plugin aborts the conversation it reports and takes the file away only after that, idle already written.
   */
  describe("the interrupt ADE asks for", () => {
    const NONCE = "a1b2c3d4e5f6a1b2c3d4e5f6"
    const request = (drop: string, at: number = Date.now()) => {
      const file = join(drop, `${NONCE}.interrupt`)
      writeFileSync(file, JSON.stringify({ at }))
      return file
    }
    const activityOf = (drop: string) => {
      const file = join(drop, `${NONCE}.activity`)
      return existsSync(file) ? parseActivity(readFileSync(file, "utf8")) : undefined
    }
    function withBusy(abort: (args: { sessionID: string }) => Promise<unknown>) {
      const status: Record<string, { type: string }> = { ses_one: { type: "busy" } }
      // An abort that goes through is what turns the TUI's status idle; a failed one leaves the turn running.
      const stopping = async (args: { sessionID: string }) => {
        const done = (await abort(args)) as { error?: unknown } | undefined
        if (!(done && done.error)) status[args.sessionID] = { type: "idle" }
        return done
      }
      const tui = fakeTui({ ses_one: { directory: "C:\\p" }, ses_child: { directory: "C:\\p", parentID: "ses_one" } }, stopping)
      ;(tui.api as Record<string, unknown>).state = {
        session: { status: (id: string) => status[id], permission: () => [], question: () => [] },
      }
      return { tui, status }
    }

    test("aborts the conversation on screen, writes idle, then takes the request away", async () => {
      const aborted: string[] = []
      const order: string[] = []
      const { drop } = launchedByAde()
      const { tui } = withBusy(async ({ sessionID }) => {
        aborted.push(sessionID)
        // At the abort the request is still there: its going has to be the answer.
        order.push(existsSync(join(drop, `${NONCE}.interrupt`)) ? "file-still-there" : "file-gone")
        return { data: true }
      })
      const plugin = await loadPlugin()
      tui.show("ses_one")
      await plugin.tui(tui.api, { intervalMs: 5 })
      await settle()
      expect(activityOf(drop)?.state).toBe("busy")
      const asked = Date.now()
      const file = request(drop, asked)
      await settle()
      expect(aborted).toEqual(["ses_one"])
      expect(order).toEqual(["file-still-there"])
      expect(existsSync(file)).toBe(false)
      // idle is written, and it is newer than the request: it is what ADE reads after the file is gone.
      const idle = activityOf(drop)!
      expect(idle).toMatchObject({ state: "idle", cwd: "C:\\p" })
      expect(JSON.parse(readFileSync(join(drop, `${NONCE}.activity`), "utf8")).sessionId).toBe("ses_one")
      expect(idle.at).toBeGreaterThanOrEqual(asked)
      // Once, and not again for a request nobody made.
      await settle()
      expect(aborted).toEqual(["ses_one"])
    })

    test("a child conversation on screen does not change which one is aborted: the pane's own", async () => {
      const aborted: string[] = []
      const { drop } = launchedByAde()
      const { tui } = withBusy(async ({ sessionID }) => (aborted.push(sessionID), { data: true }))
      const plugin = await loadPlugin()
      tui.show("ses_one")
      await plugin.tui(tui.api, { intervalMs: 5 })
      await settle()
      tui.show("ses_child")
      await settle()
      request(drop)
      await settle()
      expect(aborted).toEqual(["ses_one"])
    })

    test("an abort that fails, or answers with an error, leaves the request for ADE to time out and writes no idle", async () => {
      for (const abort of [
        async () => Promise.reject(new Error("offline")),
        async () => ({ error: { name: "NotFound" } }),
      ]) {
        const { drop } = launchedByAde()
        const { tui } = withBusy(abort)
        const plugin = await loadPlugin()
        tui.show("ses_one")
        await plugin.tui(tui.api, { intervalMs: 5 })
        await settle()
        const file = request(drop)
        await settle()
        expect(existsSync(file)).toBe(true)
        expect(activityOf(drop)?.state).toBe("busy")
      }
    })

    test("a request that is old is dropped without an abort: it is not the moment anybody asked for", async () => {
      const aborted: string[] = []
      const { drop } = launchedByAde()
      const { tui } = withBusy(async ({ sessionID }) => (aborted.push(sessionID), { data: true }))
      const plugin = await loadPlugin()
      tui.show("ses_one")
      await plugin.tui(tui.api, { intervalMs: 5 })
      await settle()
      const file = request(drop, Date.now() - 60_000)
      await settle()
      expect(aborted).toEqual([])
      expect(existsSync(file)).toBe(false)
      // A file that is not even JSON is as stale as it gets.
      writeFileSync(join(drop, `${NONCE}.interrupt`), "non json")
      await settle()
      expect(aborted).toEqual([])
      expect(existsSync(join(drop, `${NONCE}.interrupt`))).toBe(false)
    })

    test("with no conversation on screen there is nothing to abort, and the request stays unanswered", async () => {
      const aborted: string[] = []
      const { drop } = launchedByAde()
      const { tui } = withBusy(async ({ sessionID }) => (aborted.push(sessionID), { data: true }))
      const plugin = await loadPlugin()
      await plugin.tui(tui.api, { intervalMs: 5 })
      await settle()
      const file = request(drop)
      await settle()
      expect(aborted).toEqual([])
      expect(existsSync(file)).toBe(true)
    })

    test("the TUI's own status goes on being reported after the abort", async () => {
      const { drop } = launchedByAde()
      const { tui, status } = withBusy(async () => ({ data: true }))
      const plugin = await loadPlugin()
      tui.show("ses_one")
      await plugin.tui(tui.api, { intervalMs: 5 })
      await settle()
      request(drop)
      await settle()
      expect(activityOf(drop)?.state).toBe("idle")
      // A queue that went out as a new turn (0.2.11) is a turn, and is said so.
      status.ses_one = { type: "busy" }
      await settle()
      expect(activityOf(drop)?.state).toBe("busy")
    })
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
