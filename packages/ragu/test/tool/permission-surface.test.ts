import { preserveTestEnv } from "../helpers/env"
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "ragu-permission-surface-home-"))
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
])

const { InstanceScope } = await import("@/effect")
const { ToolRegistry } = await import("@/tool/registry")
const { Agent } = await import("@/agent/agent")
const { PermissionRuleset } = await import("@/permission/ruleset")
const {
  permissionPresetPatch,
  detectPermissionMode,
  presetPermissionMode,
  getPermissionActionFor,
  PERMISSION_TOOL_KEYS,
} = await import("@tui/util/permission-presets")
const { mergeDeep } = await import("remeda")

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
// `websearch` and `codesearch` are registered only with an Exa key (EXA_API_KEY or the websearch config), which a
// test machine does not have.
const FLAG_GATED = new Set([
  "lsp",
  "browser_control",
  "computer",
  "code_mode",
  "batch",
  "plan_enter",
  "plan_exit",
  "websearch",
  "codesearch",
])

async function registryIds(): Promise<Set<string>> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ragu-permission-surface-project-")))
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
    // This guard used to assert a floor on the aggregate number of preset
    // keys (>50 while the presets enumerated every tool, 33 after they
    // stopped), then an exact key set per preset with "approve for me"'s 27
    // keys typed out. Both track the tool list: they move when a tool is added
    // and the old floor was even satisfied by a preset full of the very tool
    // keys it should not have written. The expected set is derived instead,
    // from the one thing it means to be derived from:
    //
    //  - `require_approval` and `full_access` name no tool at all: the
    //    wildcard plus the three internal denies, and nothing else;
    //  - `approve_for_me` names a tool key when the tool is not deferred, or
    //    when the rule it writes is not the wildcard's action — because a
    //    named `allow` on a deferred tool is a request
    //    (`PermissionRuleset.requested`) that puts its schema in every
    //    request, while a named `ask` or `deny` is a guard and costs nothing.
    //
    // Nothing stale can creep in (the loop below rejects any key that is not a
    // real tool or a documented non-tool permission) and nothing real can go
    // missing (a tool key that drops out of `expected` while the preset still
    // relies on it fails the comparison below).
    const INTERNAL_DENIES = ["plan_enter", "plan_exit", "question"] as const
    const patchOf = (preset: "require_approval" | "approve_for_me" | "full_access") => permissionPresetPatch(preset)
    const expectedKeys: Record<string, readonly string[]> = {
      require_approval: INTERNAL_DENIES,
      full_access: INTERNAL_DENIES,
      approve_for_me: [
        ...PERMISSION_TOOL_KEYS.filter(
          (key) =>
            !ToolRegistry.DEFERRED.has(key) || getPermissionActionFor(patchOf("approve_for_me"), key) !== "allow",
        ),
        ...INTERNAL_DENIES,
      ],
    }
    const unknown: string[] = []
    for (const preset of ["require_approval", "approve_for_me", "full_access"] as const) {
      const keys = Object.keys(patchOf(preset))
        .filter((key) => key !== "*")
        .sort()
      expect(keys).toEqual([...expectedKeys[preset]].sort())
      for (const key of keys) {
        if (ids.has(key) || NON_TOOL_PERMISSIONS.has(key) || FLAG_GATED.has(key)) continue
        // `question` is registered only for app/cli/desktop clients.
        if (key === "question") continue
        unknown.push(`${preset}:${key}`)
      }
    }
    expect(unknown).toEqual([])
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

/**
 * `permissionPresetPatch` returns the wider TUI `PermissionMap` (values may be
 * `string[]`/`undefined` for path rules), while `fromConfig` takes the config
 * schema's tighter shape. The maps built here only ever hold plain actions, so
 * the single cast at each call site is the honest boundary.
 */
type AgentPermission = Parameters<typeof PermissionRuleset.fromConfig>[0]
type Ruleset = ReturnType<typeof PermissionRuleset.fromConfig>

describe("permission presets", () => {
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
    for (const key of [
      "repo_overview",
      "context_collect",
      "context_related",
      "context_diagnostics",
      "speak",
    ] as const) {
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

/**
 * What the user actually ends up with.
 *
 * The tests above read the patch a client sends. The server does not apply it:
 * `Config.update` writes `mergeDeep(existing, config)`
 * (`packages/ragu/src/config/config.ts`), so every per-tool key a previous
 * preset wrote survives the next one. That gap hid an ALTO for three commits —
 * "Approve for me" then "Require approval" kept `edit: "allow"`, so file edits,
 * reads and searches ran without asking while the UI showed "Custom". These
 * tests therefore go through the real merge and the real evaluator, starting
 * from the config on disk rather than from the patch.
 */
describe("permission presets on the config that results from the server merge", () => {
  /**
   * A config written before the presets stopped enumerating every tool: the old
   * `uniformPermissionPatch`, wildcard first, then all 29 tool keys, then the
   * three denies — the shape still on disk for anyone who picked "Full access"
   * before this branch.
   *
   * Key order is part of the fixture, not decoration: `evaluate` and
   * `requested` both take the *last* matching rule, so a map whose wildcard sat
   * last would let the wildcard outrank the internal denies and outrank every
   * per-tool rule. The old preset wrote the wildcard first, and the merge keeps
   * a key's original position, so that is the order the real file has.
   */
  const OLD_FULL_ACCESS: AgentPermission = Object.fromEntries([
    ["*", "allow"],
    ...PERMISSION_TOOL_KEYS.map((key) => [key, "allow"]),
    ["question", "deny"],
    ["plan_enter", "deny"],
    ["plan_exit", "deny"],
  ])

  /** The server's write: `mergeDeep(existing, config)` with the patch nested under the agent. */
  function applyPreset(existing: AgentPermission, preset: "require_approval" | "approve_for_me" | "full_access") {
    const patch = permissionPresetPatch(preset, existing)
    const merged = mergeDeep(
      { agent: { build: { permission: existing } } },
      { agent: { build: { permission: patch } } },
    )
    const permission = (merged.agent as Record<string, { permission: AgentPermission }>).build.permission
    return { permission, ruleset: PermissionRuleset.fromConfig(permission) }
  }

  const action = (ruleset: Ruleset, permission: string, pattern = "*") =>
    PermissionRuleset.evaluate(permission, pattern, ruleset).action

  it("approve for me then require approval asks for edits, reads and searches", () => {
    const first = applyPreset({} as AgentPermission, "approve_for_me")
    expect(action(first.ruleset, "edit", "/repo/src/main.ts")).toBe("allow")

    const second = applyPreset(first.permission, "require_approval")
    for (const [permission, pattern] of [
      ["edit", "/repo/src/main.ts"],
      ["read", "/repo/src/main.ts"],
      ["grep", "needle"],
      ["bash", "ls -la"],
    ] as const) {
      expect(action(second.ruleset, permission, pattern)).toBe("ask")
    }
    // and the map reads back as the preset, not as `custom`
    expect(detectPermissionMode(second.permission)).toBe("require_approval")
  })

  it("an old 29-key full access config then require approval asks for everything", () => {
    const { permission, ruleset } = applyPreset(OLD_FULL_ACCESS, "require_approval")
    for (const key of PERMISSION_TOOL_KEYS) {
      expect(action(ruleset, key)).toBe("ask")
    }
    expect(detectPermissionMode(permission)).toBe("require_approval")
    // the internal denies still win over the wildcard
    expect(action(ruleset, "question")).toBe("deny")
    expect(action(ruleset, "plan_enter")).toBe("deny")
    expect(action(ruleset, "plan_exit")).toBe("deny")
  })

  it("an old 29-key full access config then full access allows everything and reads as full access", () => {
    const { permission, ruleset } = applyPreset(OLD_FULL_ACCESS, "full_access")
    for (const key of PERMISSION_TOOL_KEYS) {
      expect(action(ruleset, key)).toBe("allow")
    }
    expect(detectPermissionMode(permission)).toBe("full_access")
    expect(action(ruleset, "question")).toBe("deny")
  })

  it("full access on an old config cannot un-name the deferred tools it already named", () => {
    // The honest limit of the merge-only fix: a patch cannot delete a key, so a
    // config that already lists a deferred tool keeps listing it. It was active
    // before the switch and stays active after — the preset neither adds nor
    // removes it. Requiring approval *does* clear it, because rewriting the
    // key to `ask` is not a request any more.
    const before = PermissionRuleset.fromConfig(OLD_FULL_ACCESS)
    const after = applyPreset(OLD_FULL_ACCESS, "full_access").ruleset
    expect(ToolRegistry.exposure("browser_control", { disabledTools: {}, ruleset: before })).toBe("active")
    expect(ToolRegistry.exposure("browser_control", { disabledTools: {}, ruleset: after })).toBe("active")

    const strict = applyPreset(OLD_FULL_ACCESS, "require_approval").ruleset
    expect(ToolRegistry.exposure("browser_control", { disabledTools: {}, ruleset: strict })).toBe("deferred")
    expect(ToolRegistry.exposure("computer", { disabledTools: {}, ruleset: strict })).toBe("deferred")
  })

  it("switching from approve for me to full access stops asking for bash and the network", () => {
    const first = applyPreset({} as AgentPermission, "approve_for_me")
    expect(action(first.ruleset, "bash", "ls")).toBe("ask")

    const second = applyPreset(first.permission, "full_access")
    for (const [permission, pattern] of [
      ["bash", "ls -la"],
      ["webfetch", "https://example.com"],
      ["websearch", "anything"],
      ["external_directory", "/etc/hosts"],
    ] as const) {
      expect(action(second.ruleset, permission, pattern)).toBe("allow")
    }
    expect(detectPermissionMode(second.permission)).toBe("full_access")
  })

  it("switching from full access to approve for me restores the asks", () => {
    const first = applyPreset({} as AgentPermission, "full_access")
    expect(action(first.ruleset, "bash", "ls")).toBe("allow")

    const second = applyPreset(first.permission, "approve_for_me")
    expect(action(second.ruleset, "bash", "ls")).toBe("ask")
    expect(action(second.ruleset, "read", "/repo/.env")).toBe("ask")
    expect(action(second.ruleset, "read", "/repo/src/main.ts")).toBe("allow")
    expect(action(second.ruleset, "edit", "/repo/src/main.ts")).toBe("allow")
    expect(detectPermissionMode(second.permission)).toBe("approve_for_me")
  })

  it("a user rule on a key the preset does not touch survives the switch", () => {
    // Presets rewrite what they own; a hand-written rule on an MCP tool is not
    // theirs to overwrite, and merging keeps it either way.
    const custom = { ...OLD_FULL_ACCESS, mcp_weather: "deny" } as AgentPermission
    const { ruleset } = applyPreset(custom, "require_approval")
    expect(action(ruleset, "mcp_weather")).toBe("deny")
  })

  it("auto writes nothing and leaves the map alone", () => {
    const existing = { ...OLD_FULL_ACCESS, edit: "allow" } as AgentPermission
    expect(permissionPresetPatch("auto", existing)).toEqual({})
    const merged = mergeDeep(
      { agent: { build: { permission: existing } } },
      {
        agent: { build: { permission: permissionPresetPatch("auto", existing) } },
      },
    )
    expect((merged.agent as Record<string, { permission: AgentPermission }>).build.permission).toEqual(existing)
  })
})
