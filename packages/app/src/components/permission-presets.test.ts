import { describe, expect, it } from "bun:test"
import { detectPermissionMode, permissionPresetPatch, presetPermissionMode } from "./permission-presets"

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
