import type {
  PermissionActionConfig,
  PermissionConfig,
  PermissionObjectConfig,
  PermissionRuleConfig,
} from "@nikcli-ai/sdk/httpapi"

// Pure permission-preset logic, split out of settings-permissions.tsx so it
// can be unit-tested without pulling the SolidJS component tree (which
// resolves solid-js/web to its server build under bun test).

export type PermissionAction = PermissionActionConfig
export type PermissionObject = PermissionObjectConfig
export type PermissionValue = PermissionRuleConfig | undefined
export type PermissionMap = PermissionConfig
export type PermissionPreset = "require_approval" | "approve_for_me" | "auto" | "full_access"
export type PermissionMode = PermissionPreset | "custom"
/** The server-side permission mode (`permission_mode` in nikcli.json). */
export type PermissionModeSetting = "default" | "auto"

export const PERMISSION_PRESETS = ["require_approval", "approve_for_me", "auto", "full_access"] as const

const PERMISSION_TOOL_KEYS = [
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "tree",
  "bash",
  "task",
  "skill",
  "lsp",
  "todoread",
  "todowrite",
  "webfetch",
  "websearch",
  "codesearch",
  "external_directory",
  "doom_loop",
  "browser_control",
  "computer",
  "repo_clone",
  "repo_overview",
  "generate_image",
  "memory_search",
  "context_collect",
  "context_search",
  "context_related",
  "context_diagnostics",
  "rag_index",
  "rag_search",
  "rag_status",
  "rag_reset",
  "speak",
  "plugin",
] as const

const INTERNAL_DENY_PERMISSION_KEYS = ["question", "plan_enter", "plan_exit"] as const

const APPROVE_FOR_ME_PERMISSIONS: PermissionMap = {
  "*": "allow",
  read: {
    "*": "allow",
    "*.env": "ask",
    "*.env.*": "ask",
    "*.env.example": "allow",
  },
  edit: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  tree: "allow",
  task: "allow",
  skill: "allow",
  lsp: "allow",
  todoread: "allow",
  todowrite: "allow",
  // `repo_overview`, `context_*`, `rag_search`, `rag_status` and `speak` are
  // deliberately absent: the wildcard already allows them, and a rule that
  // names a tool counts as a request for it, which activates deferred tools
  // and puts their schema in every request of the session.
  bash: "ask",
  webfetch: "ask",
  websearch: "ask",
  codesearch: "ask",
  external_directory: "ask",
  doom_loop: "ask",
  browser_control: "ask",
  computer: "ask",
  repo_clone: "ask",
  generate_image: "ask",
  memory_search: "ask",
  rag_index: "ask",
  rag_reset: "ask",
  // Writes code that nikcli loads and runs in-process from then on.
  plugin: "ask",
  question: "deny",
  plan_enter: "deny",
  plan_exit: "deny",
}

const VALID_ACTIONS = new Set<PermissionAction>(["allow", "ask", "deny"])

export function toPermissionMap(value: unknown): PermissionMap {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as PermissionMap

  const action = getPermissionAction(value)
  if (action) return { "*": action }

  return {}
}

export function getPermissionAction(value: unknown): PermissionAction | undefined {
  if (typeof value === "string" && VALID_ACTIONS.has(value as PermissionAction)) return value as PermissionAction
  return
}

export function getPermissionRuleDefault(value: unknown): PermissionAction | undefined {
  const action = getPermissionAction(value)
  if (action) return action

  if (!value || typeof value !== "object" || Array.isArray(value)) return

  return getPermissionAction((value as Record<string, unknown>)["*"])
}

export function getPermissionActionFor(map: PermissionMap, id: string, fallback: PermissionAction = "allow") {
  const direct = getPermissionRuleDefault(map[id])
  if (direct) return direct

  const wildcard = getPermissionRuleDefault(map["*"])
  if (wildcard) return wildcard

  return fallback
}

function hasRuleAction(value: PermissionValue, action: PermissionAction) {
  if (getPermissionAction(value) === action) return true
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.values(value).some((entry) => entry === action)
}

/**
 * `Full access` and `Require approval` as a single wildcard plus the three
 * internal denies — nothing that names a tool. A rule whose permission is the
 * tool's own id and whose action is `allow` reads as a deliberate request
 * (`PermissionRuleset.requested`), which activates deferred tools and puts
 * their schema in every request of the session. The wildcard covers the same
 * tools for permission purposes without activating any of them.
 */
function uniformPermissionPatch(action: PermissionAction): PermissionMap {
  const patch: PermissionMap = { "*": action }
  for (const key of INTERNAL_DENY_PERMISSION_KEYS) patch[key] = "deny"
  return patch
}

/**
 * The preset map plus a rewrite of every per-tool key the agent's map already
 * has. `config.update` writes with `mergeDeep`
 * (`packages/nikcli/src/config/config.ts`, `updateImpl` and
 * `updateGlobalImpl`), and a patch cannot delete a key: `undefined` is dropped
 * by `JSON.stringify` on the way out, and `null` fails the config schema
 * (`Permission` is the three actions, or a map of them). So a patch that wrote
 * only `*` would leave the previous preset's per-tool keys in place —
 * "Approve for me" then "Require approval" kept `edit: "allow"`, and the map
 * read back as `custom`.
 *
 * Keys the map does not have stay absent: absent is covered by `*`, and unlike
 * a named `allow` it does not count as a request for a deferred tool.
 */
function presetPatch(presetMap: PermissionMap, current?: PermissionMap): PermissionMap {
  const patch = clonePermissionMap(presetMap)
  if (!current) return patch
  for (const key of PERMISSION_TOOL_KEYS) {
    if (Object.hasOwn(patch, key)) continue
    if (!Object.hasOwn(current, key)) continue
    patch[key] = getPermissionActionFor(presetMap, key)
  }
  return patch
}

function clonePermissionMap(map: PermissionMap): PermissionMap {
  return Object.fromEntries(
    Object.entries(map).map(([key, value]) => [
      key,
      value && typeof value === "object" && !Array.isArray(value) ? { ...value } : value,
    ]),
  )
}

/**
 * Auto is a permission *mode*, not a ruleset: it keeps the current rules and
 * sends what they would prompt for to the auto mode classifier. Selecting it
 * writes `permission_mode: "auto"` and leaves the permission map alone; every
 * other preset writes its map and sets the mode back to `default`.
 */
export function presetPermissionMode(preset: PermissionPreset): PermissionModeSetting {
  return preset === "auto" ? "auto" : "default"
}

/**
 * The patch to send for `preset`, over the map the agent currently has.
 *
 * `current` is what the server will merge this into, so the rewrite of
 * already-present keys only happens when the caller knows it. Without it the
 * patch is the wildcard-only shape, which is correct on a config that has no
 * per-tool keys — and wrong on one that does.
 */
export function permissionPresetPatch(preset: PermissionPreset, current?: PermissionMap): PermissionMap {
  if (preset === "auto") return {}
  if (preset === "require_approval") return presetPatch(uniformPermissionPatch("ask"), current)
  if (preset === "full_access") return presetPatch(uniformPermissionPatch("allow"), current)
  return presetPatch(APPROVE_FOR_ME_PERMISSIONS, current)
}

export function detectPermissionMode(value: unknown, permissionMode?: unknown): PermissionMode {
  if (permissionMode === "auto") return "auto"
  const map = toPermissionMap(value)
  if (Object.keys(map).length === 0) return "approve_for_me"

  const strict = getPermissionRuleDefault(map["*"]) === "ask"
  if (strict && PERMISSION_TOOL_KEYS.every((key) => getPermissionActionFor(map, key, "ask") === "ask")) {
    return "require_approval"
  }

  const full = getPermissionRuleDefault(map["*"]) === "allow"
  if (
    full &&
    PERMISSION_TOOL_KEYS.every((key) => getPermissionActionFor(map, key) === "allow") &&
    !Object.entries(map).some(
      ([key, value]) =>
        !INTERNAL_DENY_PERMISSION_KEYS.includes(key as (typeof INTERNAL_DENY_PERMISSION_KEYS)[number]) &&
        (hasRuleAction(value, "ask") || hasRuleAction(value, "deny")),
    )
  ) {
    return "full_access"
  }

  const approveForMe =
    getPermissionRuleDefault(map["*"]) === "allow" &&
    getPermissionActionFor(map, "edit") === "allow" &&
    getPermissionActionFor(map, "bash") === "ask" &&
    getPermissionActionFor(map, "webfetch") === "ask" &&
    getPermissionActionFor(map, "websearch") === "ask" &&
    getPermissionActionFor(map, "external_directory") === "ask"

  return approveForMe ? "approve_for_me" : "custom"
}
