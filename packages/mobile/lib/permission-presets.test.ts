import { describe, expect, it } from "bun:test"
import {
  detectPermissionMode,
  getPermissionActionFor,
  permissionPresetPatch,
  presetPermissionMode,
  type PermissionMap,
} from "./permission-presets"

/**
 * Allow rules in "approve for me" that the wildcard already grants. Keeping
 * them names each tool in the agent's rules, which counts as a request and
 * pulls deferred tools into the schema of every request.
 */
const WILDCARD_COVERED_ALLOWS = [
  "repo_overview",
  "context_collect",
  "context_search",
  "context_related",
  "context_diagnostics",
  "rag_search",
  "rag_status",
  "speak",
] as const

describe("permission presets", () => {
  it("full access and require approval write only the wildcard plus the internal denies", () => {
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
    for (const key of WILDCARD_COVERED_ALLOWS) {
      expect(patch[key]).toBeUndefined()
    }
    expect(patch["*"]).toBe("allow")
    expect(patch.edit).toBe("allow")
    expect(patch.bash).toBe("ask")
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
})

/**
 * What the user ends up with, not what the client sends.
 *
 * The server does not apply the patch: `Config.update` writes
 * `mergeDeep(existing, config)` (`packages/ragu/src/config/config.ts`), so
 * every per-tool key a previous preset wrote survives the next one. That is how
 * "Approve for me" then "Require approval" could keep `edit: "allow"` — file
 * edits, reads and searches ran without asking while the UI read "Custom".
 * These cases start from the config on disk, not from the patch: the keys
 * checked are the ones the merge leaves in force.
 *
 * The merge itself is re-implemented here rather than imported (`remeda` is not
 * a mobile dependency, and a preset-only module must not gain one for a test).
 * `mergePermission` is the merge `updateImpl`/`updateGlobalImpl` perform: the
 * patch wins key by key, and nested rule objects merge one level deep. The
 * server-side `mergeDeep` is exercised against the real thing in
 * `packages/app/src/components/permission-presets.test.ts` and, with the real
 * `PermissionRuleset.evaluate`, in
 * `packages/ragu/test/tool/permission-surface.test.ts`.
 */
describe("permission presets on the config that results from the server merge", () => {
  /** `mergeDeep(existing.permission, patch)` for the shape these maps take. */
  function mergePermission(existing: PermissionMap, patch: PermissionMap): PermissionMap {
    const merged: PermissionMap = { ...existing }
    for (const [key, value] of Object.entries(patch)) {
      const previous = merged[key]
      const bothObjects =
        previous &&
        value &&
        typeof previous === "object" &&
        typeof value === "object" &&
        !Array.isArray(previous) &&
        !Array.isArray(value)
      merged[key] = bothObjects ? { ...previous, ...value } : value
    }
    return merged
  }

  /** `applyPreset` from the client's point of view, then the server's write. */
  function applyPreset(existing: PermissionMap, preset: Parameters<typeof permissionPresetPatch>[0]) {
    const permission = mergePermission(existing, permissionPresetPatch(preset, existing))
    return { permission, action: (key: string) => getPermissionActionFor(permission, key) }
  }

  /**
   * The "full access" shape written before the presets stopped enumerating every
   * tool: wildcard first, then all the tool keys, then the internal denies.
   * Still the config of anyone who picked it before that change. Order matters
   * because the evaluator takes the *last* matching rule.
   */
  const OLD_FULL_ACCESS: PermissionMap = {
    "*": "allow",
    read: "allow",
    edit: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    tree: "allow",
    bash: "allow",
    task: "allow",
    skill: "allow",
    lsp: "allow",
    todoread: "allow",
    todowrite: "allow",
    webfetch: "allow",
    websearch: "allow",
    codesearch: "allow",
    external_directory: "allow",
    doom_loop: "allow",
    browser_control: "allow",
    computer: "allow",
    repo_clone: "allow",
    repo_overview: "allow",
    generate_image: "allow",
    memory_search: "allow",
    context_collect: "allow",
    context_search: "allow",
    context_related: "allow",
    context_diagnostics: "allow",
    rag_index: "allow",
    rag_search: "allow",
    rag_status: "allow",
    rag_reset: "allow",
    speak: "allow",
    plugin: "allow",
    question: "deny",
    plan_enter: "deny",
    plan_exit: "deny",
  }

  it("approve for me then require approval asks for edits, reads and searches", () => {
    const first = applyPreset({}, "approve_for_me")
    expect(first.action("edit")).toBe("allow")

    const second = applyPreset(first.permission, "require_approval")
    for (const key of ["edit", "read", "grep", "bash", "webfetch"]) {
      expect(second.action(key)).toBe("ask")
    }
    expect(detectPermissionMode(second.permission)).toBe("require_approval")
  })

  it("an old full access config then require approval asks for everything", () => {
    const { action, permission } = applyPreset(OLD_FULL_ACCESS, "require_approval")
    for (const key of Object.keys(OLD_FULL_ACCESS)) {
      if (key === "question" || key === "plan_enter" || key === "plan_exit") continue
      expect(action(key)).toBe("ask")
    }
    expect(detectPermissionMode(permission)).toBe("require_approval")
    expect(action("question")).toBe("deny")
  })

  it("an old full access config then full access allows everything and reads as full access", () => {
    const { action, permission } = applyPreset(OLD_FULL_ACCESS, "full_access")
    for (const key of Object.keys(OLD_FULL_ACCESS)) {
      if (key === "question" || key === "plan_enter" || key === "plan_exit") continue
      expect(action(key)).toBe("allow")
    }
    expect(detectPermissionMode(permission)).toBe("full_access")
    expect(action("question")).toBe("deny")
  })

  it("switching between the presets moves both directions", () => {
    const guards = ["bash", "webfetch", "websearch", "external_directory", "plugin"] as const
    const approveForMe = applyPreset({}, "approve_for_me")
    const fullAccess = applyPreset(approveForMe.permission, "full_access")
    for (const key of guards) {
      expect(approveForMe.action(key)).toBe("ask")
      expect(fullAccess.action(key)).toBe("allow")
    }

    const backToAsking = applyPreset(fullAccess.permission, "approve_for_me")
    for (const key of guards) {
      expect(backToAsking.action(key)).toBe("ask")
    }
    expect(detectPermissionMode(backToAsking.permission)).toBe("approve_for_me")
  })

  it("a rule the presets do not own survives the switch", () => {
    // A hand-written rule on an MCP tool is not theirs to overwrite.
    const { action } = applyPreset({ ...OLD_FULL_ACCESS, mcp_weather: "deny" }, "require_approval")
    expect(action("mcp_weather")).toBe("deny")
  })

  it("auto writes nothing, so the map is untouched", () => {
    const existing: PermissionMap = { "*": "allow", edit: "allow" }
    expect(permissionPresetPatch("auto", existing)).toEqual({})
    expect(mergePermission(existing, permissionPresetPatch("auto", existing))).toEqual(existing)
  })
})
