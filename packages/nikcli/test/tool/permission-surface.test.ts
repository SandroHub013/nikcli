import { preserveTestEnv } from "../helpers/env"
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-permission-surface-home-"))
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
const { Agent } = await import("@/agent/agent")
const { PermissionRuleset } = await import("@/permission/ruleset")
const { permissionPresetPatch, detectPermissionMode, presetPermissionMode } = await import(
  "@tui/util/permission-presets"
)

/**
 * Permissions that gate something other than a registry tool. They will never
 * appear in `registry.ids()` and that is correct.
 */
const NON_TOOL_PERMISSIONS = new Set([
  // Guards any file access outside the project root, across every tool.
  "external_directory",
  // Guards the repeated-tool-call loop breaker.
  "doom_loop",
  // Guards which subagents the task tool may spawn.
  "subagents",
  // `list` is a real tool (`tool/ls.ts`, asks the `list` permission) that the
  // registry deliberately does not expose to the model — the prompt builder
  // calls it directly.
  "list",
])

/**
 * Registered only when a flag or client mode is on, so they may be legitimately
 * absent from `registry.ids()` in some builds.
 */
const FLAG_GATED = new Set(["lsp", "browser_control", "computer", "code_mode", "batch", "plan_enter", "plan_exit"])

async function registryIds(): Promise<Set<string>> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-permission-surface-project-")))
  const ids = await Effect.runPromise(
    InstanceScope.with(
      { directory },
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        return yield* registry.ids()
      }).pipe(Effect.provide(ToolRegistry.defaultLayer)),
    ),
  )
  return new Set(ids)
}

/**
 * These lists drift silently: nothing fails when a tool is removed but its
 * permission entry or agent toolset entry stays behind, so the config schema and
 * the preset UI keep advertising capabilities that no longer exist. Both carried
 * stale `rag_*`, `docs_*` and `context_search` entries before this guard existed.
 */
describe("permission and agent surfaces reference real tools", () => {
  it("every preset permission key maps to a tool or a documented non-tool permission", async () => {
    const ids = await registryIds()
    const unknown: string[] = []
    let checked = 0
    for (const preset of ["require_approval", "approve_for_me", "full_access"] as const) {
      for (const key of Object.keys(permissionPresetPatch(preset))) {
        if (key === "*") continue
        checked++
        if (ids.has(key) || NON_TOOL_PERMISSIONS.has(key) || FLAG_GATED.has(key)) continue
        // `question` is registered only for app/cli/desktop clients.
        if (key === "question") continue
        unknown.push(`${preset}:${key}`)
      }
    }
    expect(unknown).toEqual([])
    // Guard the guard: an empty preset would satisfy the assertion above. The
    // floor is the shape the presets now have by design: 3 keys for
    // full_access (the internal denies), 3 for require_approval, and 27 for
    // approve_for_me (32 entries minus the 5 wildcard-covered allow rules).
    expect(checked).toBeGreaterThanOrEqual(33)
  })

  it("every subagent toolset entry names a real tool", async () => {
    const ids = await registryIds()
    const unknown: string[] = []
    let checked = 0
    for (const [agent, tools] of Object.entries(Agent.SUBAGENT_TOOLSETS)) {
      for (const tool of tools) {
        checked++
        if (ids.has(tool) || NON_TOOL_PERMISSIONS.has(tool) || FLAG_GATED.has(tool)) continue
        unknown.push(`${agent}:${tool}`)
      }
    }
    expect(unknown).toEqual([])
    expect(checked).toBeGreaterThan(20)
  })
})

describe("permission presets", () => {
  /**
   * `permissionPresetPatch` returns the wider TUI `PermissionMap` (values may be
   * `string[]`/`undefined` for path rules), while `fromConfig` takes the config
   * schema's tighter shape. The patches built here only ever hold plain actions,
   * so the single cast at each call site is the honest boundary.
   */
  type AgentPermission = Parameters<typeof PermissionRuleset.fromConfig>[0]

  it("full access and require approval write only the wildcard plus the internal denies", () => {
    // A per-tool `allow` in an agent's rules counts as a deliberate request
    // (`PermissionRuleset.requested`) and drags every deferred tool into the
    // schema — 30 tools and ~18.7k tokens instead of 18 and ~10.4k.
    expect(permissionPresetPatch("full_access")).toEqual({
      "*": "allow",
      question: "deny",
      plan_enter: "deny",
      plan_exit: "deny",
    })
    expect(permissionPresetPatch("require_approval")).toEqual({
      "*": "ask",
      question: "deny",
      plan_enter: "deny",
      plan_exit: "deny",
    })
    expect(permissionPresetPatch("auto")).toEqual({})
  })

  it("approve for me drops the allow rules the wildcard already covers", () => {
    const patch = permissionPresetPatch("approve_for_me")
    for (const key of ["repo_overview", "context_collect", "context_related", "context_diagnostics", "speak"] as const) {
      expect(patch[key]).toBeUndefined()
    }
    expect(patch["*"]).toBe("allow")
    expect(patch.edit).toBe("allow")
    expect(patch.bash).toBe("ask")
    expect(patch.voice).toBe("ask")
    expect(patch.plugin).toBe("ask")
    expect(patch.question).toBe("deny")
    expect(patch.plan_enter).toBe("deny")
    expect(patch.plan_exit).toBe("deny")
  })

  it("detectPermissionMode recognises each preset from the map it writes", () => {
    expect(detectPermissionMode(permissionPresetPatch("require_approval"))).toBe("require_approval")
    expect(detectPermissionMode(permissionPresetPatch("approve_for_me"))).toBe("approve_for_me")
    expect(detectPermissionMode(permissionPresetPatch("full_access"))).toBe("full_access")
    expect(detectPermissionMode(permissionPresetPatch("auto"), presetPermissionMode("auto"))).toBe("auto")
  })

  it("full access keeps every non-core deferred tool deferred in the registry", () => {
    const ruleset = PermissionRuleset.fromConfig(permissionPresetPatch("full_access") as AgentPermission)
    const nonCoreDeferred = [
      "browser_control",
      "computer",
      "codesearch",
      "context_collect",
      "context_diagnostics",
      "context_related",
      "generate_image",
      "memory_search",
      "plugin",
      "repo_clone",
      "repo_overview",
      "speak",
      "voice",
      "websearch",
    ]
    for (const id of nonCoreDeferred) {
      expect(ToolRegistry.exposure(id, { disabledTools: {}, ruleset })).toBe("deferred")
    }
    expect(ToolRegistry.exposure("bash", { disabledTools: {}, ruleset })).toBe("active")
    expect(ToolRegistry.exposure("read", { disabledTools: {}, ruleset })).toBe("active")
    expect(ToolRegistry.exposure("tree", { disabledTools: {}, ruleset })).toBe("active")
  })

  it("approve for me keeps its allow-listed deferred tools deferred", () => {
    const ruleset = PermissionRuleset.fromConfig(permissionPresetPatch("approve_for_me") as AgentPermission)
    for (const id of ["repo_overview", "context_collect", "context_related", "context_diagnostics", "speak"]) {
      expect(ToolRegistry.exposure(id, { disabledTools: {}, ruleset })).toBe("deferred")
    }
    expect(ToolRegistry.exposure("bash", { disabledTools: {}, ruleset })).toBe("active")
  })
})
