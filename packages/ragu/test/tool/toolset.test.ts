import { preserveTestEnv } from "../helpers/env"
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "node:path"
import { removeTestDir } from "../helpers/fs"

/**
 * `RAGU_TOOLSET` / `experimental.toolset` pick how much of the core toolset the model's schema carries, so one
 * build serves several benchmark arms. The default must stay the shipped set; the others defer more of it, never
 * rewrite a tool's description, and leave every deferred tool reachable through search_tools + call_tool.
 */

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "ragu-toolset-home-"))
process.env.RAGU_TEST_HOME = testHome
process.env.RAGU_DISABLE_PROJECT_CONFIG = "1"
process.env.XDG_DATA_HOME = path.join(testHome, "data")
process.env.XDG_CACHE_HOME = path.join(testHome, "cache")
process.env.XDG_CONFIG_HOME = path.join(testHome, "config")
process.env.XDG_STATE_HOME = path.join(testHome, "state")

preserveTestEnv([
  "RAGU_TEST_HOME",
  "RAGU_DISABLE_PROJECT_CONFIG",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "RAGU_TOOLSET",
])

const { InstanceScope } = await import("@/effect")
const { ToolRegistry } = await import("@/tool/registry")

const projectDirs: string[] = []

async function makeProjectDir() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ragu-toolset-project-")))
  projectDirs.push(dir)
  return dir
}

/** What the registry would send for a gpt model on the given toolset: ids in schema order. */
async function shipped(directory: string, toolset?: string, model = { providerID: "openai", modelID: "gpt-5" }) {
  if (toolset) process.env.RAGU_TOOLSET = toolset
  else delete process.env.RAGU_TOOLSET
  const tools = await Effect.runPromise(
    InstanceScope.with(
      { directory },
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        return yield* registry.tools(model)
      }).pipe(Effect.provide(ToolRegistry.defaultLayer)),
    ),
  )
  const active = tools.filter((tool) => ToolRegistry.exposure(tool.id, { disabledTools: {}, ruleset: [] }) === "active")
  return { all: tools, ids: active.map((tool) => tool.id), bytes: active.reduce((n, t) => n + t.description.length, 0) }
}

afterEach(() => {
  delete process.env.RAGU_TOOLSET
  ToolRegistry.setToolset(undefined)
  ToolRegistry.setDeferralEnabled(true)
})

afterAll(async () => {
  await Promise.all(projectDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
  await removeTestDir(testHome)
})

describe("toolset switch (RAGU_TOOLSET / experimental.toolset)", () => {
  it("default is the shipped set, byte for byte", async () => {
    const dir = await makeProjectDir()
    const unset = await shipped(dir)
    const named = await shipped(dir, "default")
    const unknown = await shipped(dir, "nonsense")
    expect(named.ids).toEqual(unset.ids)
    expect(unknown.ids).toEqual(unset.ids)
    expect(ToolRegistry.deferredToolIds()).toEqual(ToolRegistry.DEFERRED)
    expect([...ToolRegistry.schemaHidden()]).toEqual([])
    for (const id of [
      "glob",
      "grep",
      "lsp",
      "skill",
      "todoread",
      "todowrite",
      "webfetch",
      "task",
      "tree",
      "monitor",
      "invalid",
    ])
      expect(unset.ids).toContain(id)
  })

  it("a1 defers exactly lsp, webfetch, skill, todoread, todowrite, grep and glob", async () => {
    const dir = await makeProjectDir()
    const base = await shipped(dir)
    const a1 = await shipped(dir, "a1")
    const removed = base.ids.filter((id) => !a1.ids.includes(id)).sort()
    expect(removed).toEqual(["glob", "grep", "lsp", "skill", "todoread", "todowrite", "webfetch"])
    expect(a1.ids.filter((id) => !base.ids.includes(id))).toEqual([])
    expect(a1.bytes).toBeLessThan(base.bytes)
  })

  it("t5 keeps only read, bash, apply_patch (or edit/write), search_tools and call_tool in the schema", async () => {
    const dir = await makeProjectDir()
    const t5 = await shipped(dir, "t5")
    expect(t5.ids.sort()).toEqual(["apply_patch", "bash", "call_tool", "invalid", "read", "search_tools"])
    expect([...ToolRegistry.schemaHidden()]).toEqual(["invalid"])
    // the tools are still registered: reachable through search_tools + call_tool
    for (const id of ["glob", "grep", "task", "todowrite", "tree", "monitor", "webfetch", "question", "skill", "lsp"])
      expect(t5.all.map((tool) => tool.id)).toContain(id)
    expect(t5.bytes).toBeLessThan((await shipped(dir, "a1")).bytes)
  })

  it("t5 on a model that edits with edit/write keeps those two instead of apply_patch", async () => {
    const dir = await makeProjectDir()
    const t5 = await shipped(dir, "t5", { providerID: "anthropic", modelID: "claude-sonnet-4-5" })
    expect(t5.ids.sort()).toEqual(["bash", "call_tool", "edit", "invalid", "read", "search_tools", "write"])
  })

  it("search_tools names the deferred tools of the toolset in one line, and the default line is unchanged", async () => {
    const dir = await makeProjectDir()
    const describe_ = async (toolset?: string) => {
      const { all } = await shipped(dir, toolset)
      return all.find((tool) => tool.id === "search_tools")!.description
    }
    const base = await describe_()
    const t5 = await describe_("t5")
    expect(base).toContain("registered but not in your tool list")
    const named = (text: string) =>
      (text.split(/\r?\n/).find((line) => line.includes("not in your tool list: ")) ?? "")
        .split("not in your tool list: ")[1]!
        .replace(/\.$/, "")
        .split(", ")
    expect(named(base)).not.toContain("grep")
    expect(named(t5)).toContain("grep")
    expect(named(t5)).toContain("task")
    expect(named(t5)).not.toContain("invalid")
    // the descriptions of the other tools are not rewritten
    const baseTools = await shipped(dir)
    const t5Tools = await shipped(dir, "t5")
    for (const id of ["bash", "read", "call_tool"])
      expect(t5Tools.all.find((t) => t.id === id)!.description).toBe(
        baseTools.all.find((t) => t.id === id)!.description,
      )
  })

  it("a rule that names a tool does not bring back what the toolset defers, but still does for the default deferrals", () => {
    const named = ["grep", "glob", "webfetch", "websearch"].map((permission) => ({
      permission,
      pattern: "*",
      action: "allow",
    })) as never
    ToolRegistry.setToolset("default")
    expect(ToolRegistry.exposure("grep", { disabledTools: {}, ruleset: named })).toBe("active")
    ToolRegistry.setToolset("a1")
    expect(ToolRegistry.exposure("grep", { disabledTools: {}, ruleset: named })).toBe("deferred")
    expect(ToolRegistry.exposure("webfetch", { disabledTools: {}, ruleset: named })).toBe("deferred")
    ToolRegistry.setToolset("t5")
    expect(ToolRegistry.exposure("glob", { disabledTools: {}, ruleset: named })).toBe("deferred")
    // websearch is in DEFERRED itself: a rule naming it still means the agent asked for it
    expect(ToolRegistry.exposure("websearch", { disabledTools: {}, ruleset: named })).toBe("active")
  })

  it("curated subagents keep what their ruleset names, whatever the toolset", () => {
    ToolRegistry.setToolset("t5")
    const curated = [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "grep", pattern: "*", action: "allow" },
    ] as never
    expect(ToolRegistry.exposure("grep", { disabledTools: {}, ruleset: curated })).toBe("active")
    expect(ToolRegistry.exposure("grep", { disabledTools: {}, ruleset: [] })).toBe("deferred")
  })
})
