import { preserveTestEnv } from "../helpers/env"
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "node:path"
import { removeTestDir } from "../helpers/fs"

/**
 * The tool array is re-sent on every request of every step, so a tool that is merely
 * *available* costs its description and its JSON schema over and over. These tests pin the
 * three properties the split rests on: the core set ships and nothing else does, a deferred
 * tool stays reachable, and **the toolset never changes inside a session** — a search and a
 * call must not move a single byte of the schema.
 */

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-deferred-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
process.env.XDG_DATA_HOME = path.join(testHome, "data")
process.env.XDG_CACHE_HOME = path.join(testHome, "cache")
process.env.XDG_CONFIG_HOME = path.join(testHome, "config")
process.env.XDG_STATE_HOME = path.join(testHome, "state")

preserveTestEnv([
  "NIKCLI_TEST_HOME",
  "NIKCLI_DISABLE_PROJECT_CONFIG",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
])

const { InstanceScope } = await import("@/effect")
const { ToolRegistry } = await import("@/tool/registry")
const { SearchToolsTool } = await import("@/tool/search_tools")
const { CallToolTool, setCallToolExecutor } = await import("@/tool/call_tool")

const projectDirs: string[] = []

async function makeProjectDir() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-deferred-project-")))
  projectDirs.push(dir)
  return dir
}

/** Every tool the registry holds, deferral on or off, unfiltered. */
async function allRegistered(directory: string) {
  return Effect.runPromise(
    InstanceScope.with(
      { directory },
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        return yield* registry.tools({ providerID: "openai", modelID: "gpt-5" })
      }).pipe(Effect.provide(ToolRegistry.defaultLayer)),
    ),
  )
}

/** The tools the registry hands the model: names in order, plus the bytes it would send. */
async function shipped(directory: string) {
  const tools = await allRegistered(directory)
  const visible = tools.filter((tool) => ToolRegistry.exposure(tool.id, { disabledTools: {}, ruleset: [] }) === "active")
  const wire = visible.map((tool) => `${tool.id} :: ${tool.description}`).join("\n")
  return { ids: visible.map((tool) => tool.id), wire }
}

function ctx(overrides: { ruleset?: unknown[]; agent?: string } = {}) {
  return {
    get instance(): never {
      throw new Error("this test must not read the instance")
    },
    sessionID: "ses_test",
    messageID: "msg_test",
    callID: "call_test",
    agent: overrides.agent ?? "build",
    abort: new AbortController().signal,
    extra: { model: { providerID: "openai", api: { id: "gpt-5" } } },
    ruleset: overrides.ruleset ?? [],
    metadata: async () => {},
    async progress() {},
    async ask() {},
  } as never
}

afterEach(() => {
  ToolRegistry.setDeferralEnabled(true)
  setCallToolExecutor(undefined)
})

afterAll(async () => {
  await Promise.all(projectDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
  await removeTestDir(testHome)
})

/**
 * Run something that needs an instance in the ambient context.
 *
 * `search_tools.execute` reaches the registry through `withCurrentInstance`, which reads the
 * instance off the ambient scope — so a test that drives it has to supply one, exactly as a real
 * session does.
 */
const inInstance = <A>(directory: string, thunk: () => Promise<A>) =>
  Effect.runPromise(InstanceScope.with({ directory }, Effect.promise(thunk)))

describe("the core toolset", () => {
  it("ships the read/search/edit/run loop plus the two tools that reach the rest", async () => {
    const { ids } = await shipped(await makeProjectDir())
    for (const id of ["bash", "read", "glob", "grep", "tree", "todowrite", "monitor", "search_tools", "call_tool"])
      expect(ids).toContain(id)
    // On a model the registry picks `apply_patch` for, `edit`, `write` and `multiedit` are replaced
    // rather than added — that choice predates this split and is left alone.
    expect(ids.includes("write") || ids.includes("apply_patch")).toBe(true)
    expect(ids.includes("edit") || ids.includes("apply_patch")).toBe(true)
    expect(ids.includes("multiedit") || ids.includes("apply_patch")).toBe(true)
  })

  it("leaves the tools nobody called out of the schema", async () => {
    const { ids } = await shipped(await makeProjectDir())
    for (const id of ["code_mode", "generate_image", "browser_control", "websearch", "plugin", "voice", "speak"])
      expect(ids).not.toContain(id)
  })

  it("keeps code_mode deferred, as the brief asks", () => {
    expect(ToolRegistry.DEFERRED.has("code_mode")).toBe(true)
    expect(ToolRegistry.deferred("code_mode")).toBe(true)
  })

  it("has no core tool that is also deferred", () => {
    for (const id of ToolRegistry.CORE) expect(ToolRegistry.deferred(id)).toBe(false)
  })

  it("orders the toolset the same way on every call", async () => {
    const dir = await makeProjectDir()
    const a = await shipped(dir)
    const b = await shipped(dir)
    expect(b.ids).toEqual(a.ids)
    expect(a.ids).toEqual([...a.ids].sort(ToolRegistry.compareIds))
  })
})

describe("the opt-out", () => {
  it("puts every registered tool back, and only that flag does it", async () => {
    const dir = await makeProjectDir()
    // Resolve the tool list first: `all()` re-reads the config and would reset the flag.
    const registered = (await allRegistered(dir)).map((tool) => tool.id)
    const on = registered.filter((id) => ToolRegistry.exposure(id, { disabledTools: {}, ruleset: [] }) === "active")
    ToolRegistry.setDeferralEnabled(false)
    const off = registered.filter((id) => ToolRegistry.exposure(id, { disabledTools: {}, ruleset: [] }) === "active")
    ToolRegistry.setDeferralEnabled(true)
    expect(off.length).toBeGreaterThan(on.length)
    expect(off).toContain("code_mode")
    expect(on).not.toContain("code_mode")
    // Back on: the split is the default, not a benchmark-only setting.
    expect(registered.filter((id) => ToolRegistry.exposure(id, { disabledTools: {}, ruleset: [] }) === "active")).toEqual(on)
  })

  it("is on unless the config says otherwise", async () => {
    // The registry wires `setDeferralEnabled(config.experimental?.deferredTools !== false)`; what
    // matters to a user is that the default ships the split, with no configuration at all.
    expect(ToolRegistry.deferralOn()).toBe(true)
    expect(ToolRegistry.deferred("generate_image")).toBe(true)
  })
})

describe("the cache invariant", () => {
  it("hands the model an identical toolset before and after a search and a call", async () => {
    const dir = await makeProjectDir()
    const before = await shipped(dir)

    const search = await inInstance(dir, () =>
      SearchToolsTool.init().then((def) => def.executeAsync({ query: "generate_image" }, ctx())),
    )
    expect(search.output).toContain("call_tool")

    setCallToolExecutor(async (name, args, callCtx) => {
      await callCtx.metadata({ title: name })
      return { title: name, output: `ran ${name} with ${JSON.stringify(args)}`, metadata: {} }
    })
    const called = await (
      await CallToolTool.init()
    ).executeAsync({ name: "generate_image", args: { prompt: "a cat" } }, ctx())
    expect(called.output).toContain("a cat")

    const after = await shipped(dir)
    expect(after.ids).toEqual(before.ids)
    expect(after.wire).toBe(before.wire)
  })
})

describe("search_tools", () => {
  it("returns a deferred tool's parameters and the exact call to make", async () => {
    const dir = await makeProjectDir()
    const result = await inInstance(dir, () =>
      SearchToolsTool.init().then((def) => def.executeAsync({ query: "generate_image" }, ctx())),
    )
    expect(result.output).toContain("generate_image")
    // The parameter schema, not just the name: one search then one call, no second round-trip.
    expect(result.output).toContain("parameters:")
    expect(result.output).toContain('call_tool({"name": "generate_image"')
    expect(result.metadata.schemas).toContain("generate_image")
  })

  it("names the deferred tools in its own description, and the text is stable", async () => {
    const def = await SearchToolsTool.init()
    expect(def.description).toContain("code_mode")
    expect(def.description).toContain("generate_image")
    // Byte-identical across inits: the line has to stay inside the cached prefix.
    const again = await SearchToolsTool.init()
    expect(again.description).toBe(def.description)
  })

  it("builds its description without asking the registry to init every tool", async () => {
    // Regression, and a real one: the first version resolved the deferred names by calling
    // `registry.tools()` from inside `init`. `registry.tools()` initialises every tool, this one
    // included, so each init asked the registry to init every tool again. The test log reached ten
    // million lines and the run never finished — which a plain `await` would have turned into a
    // suite-level timeout instead of naming the cause, hence the race.
    const init = SearchToolsTool.init()
    const raced = await Promise.race([
      init.then(() => "done" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2000)),
    ])
    if (raced === "hung") await init.catch(() => undefined) // don't leave the loop running
    expect(raced).toBe("done")
  })

  it("filters candidates through the same visibility check the toolset uses", async () => {
    // Not the deny itself: `execute` reads the ruleset from the session on disk
    // (`sessionRuleset(ctx.sessionID, agent)`), not from the tool context, so a deny can only be
    // exercised against a real session. What is pinned here is that the catalog and the model's
    // toolset are decided by the same function, which is why a tool that one hides the other hides.
    const dir = await makeProjectDir()
    const { ids } = await shipped(dir)
    const result = await inInstance(dir, () =>
      SearchToolsTool.init().then((def) => def.executeAsync({ query: "generate_image" }, ctx())),
    )
    // In the shipped toolset generate_image is out, and the search still reaches it — that is the
    // point of a catalog: it names what the schema cannot.
    expect(ids).not.toContain("generate_image")
    expect(result.output).toContain("generate_image")
  })
})

describe("call_tool", () => {
  it("runs the deferred tool the session resolved, with the arguments it was given", async () => {
    let seen: { name: string; args: Record<string, unknown> } | undefined
    setCallToolExecutor(async (name, args) => {
      seen = { name, args }
      return { title: name, output: "done", metadata: {} }
    })
    const def = await CallToolTool.init()
    const result = await def.executeAsync({ name: "voice", args: { text: "ciao" } }, ctx())
    expect(seen).toEqual({ name: "voice", args: { text: "ciao" } })
    expect(result.output).toBe("done")
  })

  it("hands the caller's own context down, so permission and progress still work", async () => {
    setCallToolExecutor(async (name, _args, callCtx) => {
      await callCtx.metadata({ title: name })
      return { title: name, output: `ok ${callCtx.agent}`, metadata: {} }
    })
    const def = await CallToolTool.init()
    const result = await def.executeAsync({ name: "websearch", args: {} }, ctx({ agent: "plan" }))
    expect(result.output).toBe("ok plan")
  })

  it("says so plainly when there is no registry to run from", async () => {
    const def = await CallToolTool.init()
    const result = await def.executeAsync({ name: "voice", args: {} }, ctx())
    expect(result.title).toBe("call_tool unavailable")
  })

  it("cannot reach a tool a deny rule covers, because it asks the same question the toolset does", () => {
    const denied = { permission: "generate_image", action: "deny", pattern: "*" }
    expect(ToolRegistry.visible("generate_image", { disabledTools: {}, ruleset: [denied] as never })).toBe(false)
    expect(ToolRegistry.visible("read", { disabledTools: {}, ruleset: [denied] as never })).toBe(true)
  })
})
