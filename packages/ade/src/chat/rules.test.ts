import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { translate } from "../i18n"
import { CHAT_PERMISSION, hasChatRules, type PermissionRule } from "./rules"

/*
 * C5: the chat's rules win over the agent's, as nikcli decides them: the last
 * rule that matches, agent's first, session's after (`permission/next.ts`,
 * `evaluate`; the wildcard of `util/wildcard.ts`, copied here).
 */

function matches(value: string, pattern: string) {
  let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp("^" + escaped + "$", "s").test(value)
}

function decide(permission: string, pattern: string, ...rulesets: (readonly PermissionRule[])[]) {
  const match = rulesets.flat().findLast((rule) => matches(permission, rule.permission) && matches(pattern, rule.pattern))
  return match?.action ?? "ask"
}

const rule = (permission: string, pattern: string, action: PermissionRule["action"]): PermissionRule => ({ permission, pattern, action })

/** nikcli's defaults for an agent (`agent/agent.ts`), then this machine's user config: `bash *: allow`. */
const BUILD: PermissionRule[] = [
  rule("*", "*", "allow"),
  rule("browser_control", "*", "ask"),
  rule("computer", "*", "ask"),
  rule("doom_loop", "*", "ask"),
  rule("external_directory", "*", "ask"),
  rule("question", "*", "deny"),
  rule("read", "*", "allow"),
  rule("read", "*.env", "ask"),
  rule("read", "*.env.*", "ask"),
  rule("read", "*.env.example", "allow"),
  rule("question", "*", "allow"),
  rule("bash", "*", "allow"),
]

describe("the chat session's permission rules", () => {
  test("without them, this machine's build agent runs any shell command and edit unasked", () => {
    expect(decide("bash", "rm -rf build", BUILD)).toBe("allow")
    expect(decide("edit", "src/a.ts", BUILD)).toBe("allow")
  })

  test("with them, what changes things or leaves the project asks; subagents, computer and browser are denied", () => {
    const cases: [string, string, PermissionRule["action"]][] = [
      ["bash", "rm -rf build", "ask"],
      ["bash", "ls", "ask"],
      ["edit", "src/a.ts", "ask"],
      ["write", "src/b.ts", "ask"],
      ["external_directory", "C:/Users/utente/*", "ask"],
      ["webfetch", "https://example.com", "ask"],
      ["mcp_github_create_issue", "*", "ask"],
      ["uno_strumento_di_domani", "*", "ask"],
      ["read", "src/a.ts", "allow"],
      ["read", ".env", "ask"],
      ["read", "config/.env.local", "ask"],
      ["read", ".env.example", "allow"],
      ["grep", "TODO", "allow"],
      ["glob", "**/*.ts", "allow"],
      ["question", "*", "allow"],
      ["todowrite", "*", "allow"],
      ["task", "general", "deny"],
      ["computer", "*", "deny"],
      ["browser_control", "*", "deny"],
      ["plan_enter", "*", "deny"],
    ]
    for (const [permission, pattern, action] of cases) {
      expect([permission, pattern, decide(permission, pattern, BUILD, CHAT_PERMISSION)]).toEqual([permission, pattern, action])
    }
  })

  test("a session is the chat's when its rules end with the chat's own", () => {
    expect(hasChatRules({ permission: [...CHAT_PERMISSION] })).toBe(true)
    expect(hasChatRules({ permission: [rule("bash", "git *", "allow"), ...CHAT_PERMISSION] })).toBe(true)
    expect(hasChatRules({ permission: undefined })).toBe(false)
    expect(hasChatRules({ permission: [] })).toBe(false)
    expect(hasChatRules(undefined)).toBe(false)
    // Something after them would decide instead: not the chat's.
    expect(hasChatRules({ permission: [...CHAT_PERMISSION, rule("bash", "*", "allow")] })).toBe(false)
    expect(hasChatRules({ permission: CHAT_PERMISSION.slice(1) })).toBe(false)
  })
})

describe("what the rules cannot stop", () => {
  test("a project's saved «always» is said, in both languages", () => {
    expect(translate("it", "chat.rules.always")).toContain("«sempre»")
    expect(translate("en", "chat.rules.always")).toContain("«always»")
  })

  test("lint: RulesNote draws that note from the chat.rules.always key", () => {
    const parts = readFileSync(new URL("./parts.tsx", import.meta.url), "utf8")
    expect(parts).toMatch(/export function RulesNote\(\)[\s\S]*?t\("chat\.rules\.always"\)/)
  })
})
