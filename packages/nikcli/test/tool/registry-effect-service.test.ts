import { preserveTestEnv } from "../helpers/env"
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-tool-registry-effect-home-"))
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

const { InstanceScope, InstanceState } = await import("@/effect")
const { Instance } = await import("@/project/instance")
const { ToolRegistry } = await import("@/tool/registry")
const { Tool } = await import("@/tool/tool")
const z = (await import("zod")).default

const projectDirs: string[] = []

async function makeProjectDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-tool-registry-effect-project-"))
  const resolved = await fs.realpath(dir)
  projectDirs.push(resolved)
  return resolved
}

describe("ToolRegistry.Service", () => {
  it("lists built-in tool ids through InstanceState context", async () => {
    const directory = await makeProjectDir()
    const ids = await Effect.runPromise(
      InstanceScope.with(
        { directory },
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          return yield* registry.ids()
        }).pipe(Effect.provide(ToolRegistry.defaultLayer)),
      ),
    )

    expect(ids).toContain("bash")
    expect(ids).toContain("read")
    expect(ids).toContain("create_goal")
    expect(ids).toContain("get_goal")
    expect(ids).toContain("update_goal")
    expect(ids).toContain("browser_control")
    expect(ids).toContain("computer")
    expect(ids).toContain("multiedit")
    expect(ids).toContain("voice")
  })

  it("offers the string-replace edit family and apply_patch as alternatives, never both", async () => {
    const directory = await makeProjectDir()
    const resolve = (modelID: string) =>
      Effect.runPromise(
        InstanceScope.with(
          { directory },
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            return yield* registry.tools({ providerID: "openai", modelID })
          }).pipe(Effect.provide(ToolRegistry.defaultLayer)),
        ),
      ).then((tools) => new Set(tools.map((tool) => tool.id)))

    const gpt = await resolve("gpt-5")
    expect(gpt.has("apply_patch")).toBe(true)
    for (const id of ["edit", "write", "multiedit"]) expect(gpt.has(id)).toBe(false)

    const claude = await resolve("claude-opus-5")
    expect(claude.has("apply_patch")).toBe(false)
    for (const id of ["edit", "write", "multiedit"]) expect(claude.has(id)).toBe(true)
  })

  it("resolves tool definitions and honours exclude", async () => {
    const directory = await makeProjectDir()
    const resolve = (options?: { exclude?: ReadonlySet<string> }) =>
      Effect.runPromise(
        InstanceScope.with(
          { directory },
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            return yield* registry.tools({ providerID: "", modelID: "" }, undefined, options)
          }).pipe(Effect.provide(ToolRegistry.defaultLayer)),
        ),
      )

    const tools = await resolve()
    expect(tools.some((tool) => tool.id === "bash")).toBe(true)
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0)
    }

    // `exclude` is what keeps code_mode from bridging recursive/UI-only tools
    // into its own catalog.
    const trimmed = await resolve({ exclude: new Set(["bash"]) })
    expect(trimmed.some((tool) => tool.id === "bash")).toBe(false)
    expect(trimmed.length).toBe(tools.length - 1)
  })

  // The tool array is the first and largest component of the provider prompt-cache
  // prefix. Registration order varies with plugin load order and `register()` calls,
  // so an equivalent tool set has to serialize to identical bytes regardless.
  it("returns tools in canonical id order", async () => {
    const directory = await makeProjectDir()
    const tools = await Effect.runPromise(
      InstanceScope.with(
        { directory },
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          return yield* registry.tools({ providerID: "", modelID: "" })
        }).pipe(Effect.provide(ToolRegistry.defaultLayer)),
      ),
    )

    const ids = tools.map((tool) => tool.id)
    expect(ids).toEqual([...ids].sort(ToolRegistry.compareIds))
    expect(ids.length).toBeGreaterThan(1)
  })

  it("defers the listed tools until the user loads them", () => {
    // An absent entry is "not loaded yet", an explicit `false` is switched on,
    // and `true` is the user switching the tool off. A deferred tool is never
    // loaded by the model itself: the schema stays the same all session.
    expect(ToolRegistry.exposure("generate_image", { disabledTools: {}, ruleset: [] })).toBe("deferred")
    expect(ToolRegistry.exposure("generate_image", { disabledTools: { generate_image: false }, ruleset: [] })).toBe(
      "active",
    )
    expect(ToolRegistry.exposure("generate_image", { disabledTools: { generate_image: true }, ruleset: [] })).toBe(
      "hidden",
    )
    // Opt-in tools wait for a human and are not even reachable through call_tool.
    expect(ToolRegistry.exposure("opentui", { ruleset: [] })).toBe("hidden")
    expect(ToolRegistry.exposure("opentui", { disabledTools: { opentui: false }, ruleset: [] })).toBe("active")
    // Plugin and custom tools are not on the explicit deferred list: they keep their schema.
    expect(ToolRegistry.exposure("live_scores", { ruleset: [] })).toBe("active")

    // Core tools keep the plain meaning: on unless switched off.
    expect(ToolRegistry.exposure("bash", { ruleset: [] })).toBe("active")
    expect(ToolRegistry.exposure("bash", { disabledTools: { bash: false }, ruleset: [] })).toBe("active")
    expect(ToolRegistry.exposure("bash", { disabledTools: { bash: true }, ruleset: [] })).toBe("hidden")
    // A switched-off deferred tool is not usable, a plain deferred one is.
    expect(ToolRegistry.visible("generate_image", { disabledTools: {}, ruleset: [] })).toBe(true)
    expect(ToolRegistry.visible("generate_image", { disabledTools: { generate_image: true }, ruleset: [] })).toBe(
      false,
    )
  })

  it("loads configured tools from the first request", () => {
    expect(ToolRegistry.exposure("generate_image", { ruleset: [], eager: ["generate_image"] })).toBe("active")
    expect(ToolRegistry.exposure("code_mode", { ruleset: [], eager: ["code_*"] })).toBe("active")
    expect(ToolRegistry.exposure("code_mode", { ruleset: [], eager: ["*"] })).toBe("active")
    // Configuring a tool as eager does not override the user switching it off.
    expect(
      ToolRegistry.exposure("code_mode", { disabledTools: { code_mode: true }, ruleset: [], eager: ["*"] }),
    ).toBe("hidden")
  })

  it("defers nothing for an agent with a curated toolset", () => {
    // `scout`-style: everything not named is denied, so what is left is the
    // agent's working set.
    const curated = [
      { permission: "*", pattern: "*", action: "allow" as const },
      { permission: "*", pattern: "*", action: "deny" as const },
      { permission: "code_mode", pattern: "*", action: "allow" as const },
    ]
    expect(ToolRegistry.curated(curated)).toBe(true)
    expect(ToolRegistry.exposure("code_mode", { ruleset: curated })).toBe("active")
    expect(ToolRegistry.exposure("generate_image", { ruleset: curated })).toBe("hidden")

    // An open agent that denies a few tools is not curated.
    const open = [
      { permission: "*", pattern: "*", action: "allow" as const },
      { permission: "plan_exit", pattern: "*", action: "deny" as const },
    ]
    expect(ToolRegistry.curated(open)).toBe(false)
    expect(ToolRegistry.exposure("code_mode", { ruleset: open })).toBe("deferred")
  })

  it("names only tools the registry can actually register in the core set", async () => {
    // A typo here would silently defer a core tool.
    const directory = await makeProjectDir()
    const ids = await Effect.runPromise(
      InstanceScope.with(
        { directory },
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          return yield* registry.ids()
        }).pipe(Effect.provide(ToolRegistry.defaultLayer)),
      ),
    )
    // `question` depends on the client and `batch` on config; both are
    // registered conditionally.
    const registrable = new Set([...ids, "question", "batch"])
    expect([...ToolRegistry.CORE].filter((id) => !registrable.has(id))).toEqual([])
  })

  it("orders ids by code unit rather than host locale", () => {
    // `localeCompare` would sort "Zebra" after "apple" under most locales, making the
    // same tool set serialize differently on different machines.
    expect(["apple", "Zebra"].sort(ToolRegistry.compareIds)).toEqual(["Zebra", "apple"])
    expect(ToolRegistry.compareIds("bash", "bash")).toBe(0)
  })

  it("lastWins keeps first-seen order and the latest occupant of each id", () => {
    const tools = [
      { id: "a", n: 1 },
      { id: "b", n: 1 },
      { id: "a", n: 2 },
    ]
    expect(ToolRegistry.lastWins(tools)).toEqual([
      { id: "a", n: 2 },
      { id: "b", n: 1 },
    ])
  })

  it("returns a handle that removes exactly that registration and reveals the previous occupant", async () => {
    const directory = await makeProjectDir()
    const first = Tool.define("overlay_tool", {
      description: "first",
      parameters: z.object({}),
      async execute() {
        return { title: "", output: "first", metadata: {} }
      },
    })
    const second = Tool.define("overlay_tool", {
      description: "second",
      parameters: z.object({}),
      async execute() {
        return { title: "", output: "second", metadata: {} }
      },
    })

    const result = await Effect.runPromise(
      InstanceScope.with(
        { directory },
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const older = yield* registry.register(first)
          const newer = yield* registry.register(second)
          const during = yield* registry.tools({ providerID: "", modelID: "" })
          yield* newer.close
          const afterNewer = yield* registry.tools({ providerID: "", modelID: "" })
          yield* older.close
          const afterOlder = yield* registry.ids()
          return {
            during: during.find((tool) => tool.id === "overlay_tool")?.description,
            afterNewer: afterNewer.find((tool) => tool.id === "overlay_tool")?.description,
            afterOlder: afterOlder.includes("overlay_tool"),
            bashCount: afterOlder.filter((id) => id === "bash").length,
          }
        }).pipe(Effect.provide(ToolRegistry.defaultLayer)),
      ),
    )

    expect(result.during).toBe("second")
    expect(result.afterNewer).toBe("first")
    expect(result.afterOlder).toBe(false)
    expect(result.bashCount).toBe(1)
  })

  it("keeps runtime registrations across a derived-cache reload", async () => {
    const directory = await makeProjectDir()
    const sticky = Tool.define("sticky_runtime", {
      description: "runtime",
      parameters: z.object({}),
      async execute() {
        return { title: "", output: "ok", metadata: {} }
      },
    })

    const ids = await Effect.runPromise(
      InstanceScope.with(
        { directory },
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          yield* registry.register(sticky)
          yield* InstanceState.invalidateReloadable(directory)
          return yield* registry.ids()
        }).pipe(Effect.provide(ToolRegistry.defaultLayer)),
      ),
    )

    expect(ids).toContain("sticky_runtime")
    expect(ids.filter((id) => id === "sticky_runtime")).toHaveLength(1)
  })

  it("shadows a built-in until the handle closes", async () => {
    const directory = await makeProjectDir()
    const replacement = Tool.define("bash", {
      description: "replacement bash",
      parameters: z.object({}),
      async execute() {
        return { title: "", output: "nope", metadata: {} }
      },
    })

    const result = await Effect.runPromise(
      InstanceScope.with(
        { directory },
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const before = yield* registry.tools({ providerID: "", modelID: "" })
          const handle = yield* registry.register(replacement)
          const during = yield* registry.tools({ providerID: "", modelID: "" })
          yield* handle.close
          const after = yield* registry.tools({ providerID: "", modelID: "" })
          const pick = (list: typeof before) => list.find((tool) => tool.id === "bash")?.description
          return { before: pick(before), during: pick(during), after: pick(after) }
        }).pipe(Effect.provide(ToolRegistry.defaultLayer)),
      ),
    )

    expect(result.during).toBe("replacement bash")
    expect(result.after).toBe(result.before)
    expect(result.before).not.toBe("replacement bash")
  })
})

afterEach(async () => {
  await Instance.disposeAll().catch(() => undefined)
})

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  await Promise.all(projectDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
  await fs.rm(testHome, { recursive: true, force: true })
})
