import { describe, expect, test } from "bun:test"
import type { PermissionRule } from "../chat/rules"
import { blockedBashDenials, botPermission, hasBotRules, profileFor, type BotProfile } from "./serve-rules"

/*
 * B8d: a bot's session rules win over its own file, as nikcli decides them:
 * the last rule that matches, the agent's first, the session's after
 * (`permission/next.ts`, `evaluate`; the wildcard of `util/wildcard.ts`,
 * copied here as in `chat/rules.test.ts`). `scripts/check-nikcli-permission.ts`
 * asks nikcli's own code the same questions.
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

/** A bot file that grants itself everything, after nikcli's defaults and a user config with `bash *: allow`. */
const HOSTILE: PermissionRule[] = [
  rule("*", "*", "allow"),
  rule("bash", "*", "allow"),
  rule("bash", "git *", "allow"),
  rule("external_directory", "*", "allow"),
  rule("computer", "*", "allow"),
  rule("task", "*", "allow"),
  rule("edit", "*", "allow"),
]

const BLOCKED = [
  "rm -rf ~",
  "rm -rf /",
  "sudo rm -rf /",
  "rm -rf $HOME",
  "mkfs.ext4 /dev/x",
  "shutdown /s /t 0",
  "Remove-Item -Recurse -Force C:\\",
  "Remove-item -Recurse -Force C:\\",
  "FORMAT C:",
  "diskpart",
]
const EVERYDAY = ["git status", "ls -la", "bun test", "npm run build"]
const PROFILES: BotProfile[] = ["ask", "ask-outside", "no-shell", "read-only", "remote-ask", "remote-none"]

describe("B8d: the rules of a bot's session", () => {
  test("the block list is denied where the shell asks, whatever the bot's file grants", () => {
    for (const profile of ["ask", "remote-ask"] as const) {
      for (const command of BLOCKED) expect([profile, command, decide("bash", command, HOSTILE, botPermission(profile))]).toEqual([profile, command, "deny"])
      for (const command of EVERYDAY) expect(decide("bash", command, HOSTILE, botPermission(profile))).toBe("ask")
    }
  })

  test("no shell where there is none to answer, and nothing written by a routine", () => {
    for (const profile of ["ask-outside", "no-shell", "read-only", "remote-none"] as const) {
      for (const command of [...BLOCKED, ...EVERYDAY]) expect(decide("bash", command, HOSTILE, botPermission(profile))).toBe("deny")
    }
    for (const tool of ["edit", "write", "patch", "repo_clone", "generate_image", "artifact"]) {
      expect(decide(tool, "src/a.ts", HOSTILE, botPermission("read-only"))).toBe("deny")
      // Elsewhere writing is the bot's own rule, as with the spawn flags.
      expect(decide(tool, "src/a.ts", HOSTILE, botPermission("ask"))).toBe("allow")
    }
  })

  test("outside the project, the computer and the browser: as the spawn flags had them", () => {
    const expected: Record<BotProfile, [string, string, string]> = {
      ask: ["ask", "ask", "ask"],
      "ask-outside": ["ask", "ask", "ask"],
      "no-shell": ["deny", "deny", "deny"],
      "read-only": ["deny", "deny", "deny"],
      "remote-ask": ["ask", "deny", "deny"],
      "remote-none": ["ask", "deny", "deny"],
    }
    for (const profile of PROFILES) {
      const got = ["external_directory", "computer", "browser_control"].map((tool) => decide(tool, "*", HOSTILE, botPermission(profile)))
      expect([profile as string, ...got]).toEqual([profile, ...expected[profile]])
    }
  })

  test("never a subagent, plan mode or a question, in any profile", () => {
    for (const profile of PROFILES) {
      for (const tool of ["task", "plan_enter", "plan_exit", "question"]) expect(decide(tool, "*", HOSTILE, botPermission(profile))).toBe("deny")
    }
  })

  test("the list is the one pty.rs used: every form, deduplicated", () => {
    const list = blockedBashDenials()
    expect(new Set(list).size).toBe(list.length)
    for (const pattern of ["rm * ~", "sudo rm * / *", "rm -rf", "Remove-Item * ?:\\", "remove-item * ~", "FORMAT ?:*", "dd *of=/dev/*", "Remove-item * ?:\\"])
      expect(list).toContain(pattern)
    expect(botPermission("ask").at(-1)!.permission).toBe("bash")
    expect(botPermission("ask").at(-1)!.action).toBe("deny")
  })

  test("a session is the bot's when its rules end with the profile's; another, or none, is not", () => {
    for (const profile of PROFILES) {
      expect(hasBotRules({ permission: [rule("*", "*", "ask"), ...botPermission(profile)] }, profile)).toBe(true)
      for (const other of PROFILES.filter((p) => p !== profile)) expect(hasBotRules({ permission: [...botPermission(profile)] }, other)).toBe(false)
    }
    expect(hasBotRules({ permission: [] }, "ask")).toBe(false)
    expect(hasBotRules(undefined, "ask")).toBe(false)
    expect(hasBotRules({ permission: "nope" }, "ask")).toBe(false)
  })

  test("the profile of a turn, as runners.ts chose the spawn flag", () => {
    expect(profileFor({ remote: { commands: true }, shell: true })).toBe("remote-ask")
    expect(profileFor({ remote: { commands: false }, shell: true })).toBe("remote-none")
    expect(profileFor({ unattended: true, shell: true })).toBe("read-only")
    expect(profileFor({ approvals: true, shell: true })).toBe("ask")
    expect(profileFor({ approvals: true, shell: false })).toBe("ask-outside")
    expect(profileFor({ shell: true })).toBe("no-shell")
  })
})
