import { describe, expect, test } from "bun:test"
import type { PermissionRule } from "../chat/rules"
import { BLOCKED as BLOCK_RULES, classifyCommand } from "./approval"
import {
  blockedBashDenials,
  botPermission,
  configDenials,
  hasBotRules,
  profileFor,
  type BotProfile,
} from "./serve-rules"
import { it as itDict } from "../i18n/it"
import { en as enDict } from "../i18n/en"

/*
 * B8d: a bot's session rules win over its own file, as nikcli decides them:
 * the last rule that matches, the agent's first, the session's after
 * (`permission/next.ts`, `evaluate`; the wildcard of `util/wildcard.ts`,
 * copied here as in `chat/rules.test.ts`). `scripts/check-nikcli-permission.ts`
 * asks nikcli's own code the same questions.
 */

function matches(value: string, pattern: string) {
  let escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp("^" + escaped + "$", "s").test(value)
}

function decide(permission: string, pattern: string, ...rulesets: (readonly PermissionRule[])[]) {
  const match = rulesets
    .flat()
    .findLast((rule) => matches(permission, rule.permission) && matches(pattern, rule.pattern))
  return match?.action ?? "ask"
}

const rule = (permission: string, pattern: string, action: PermissionRule["action"]): PermissionRule => ({
  permission,
  pattern,
  action,
})

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
const PROFILES: BotProfile[] = ["ask", "ask-outside", "no-shell", "read-only", "remote-ask", "remote-none", "planner"]

describe("B8d: the rules of a bot's session", () => {
  test("the block list is denied where the shell asks, whatever the bot's file grants", () => {
    for (const profile of ["ask", "remote-ask"] as const) {
      for (const command of BLOCKED)
        expect([profile, command, decide("bash", command, HOSTILE, botPermission(profile))]).toEqual([
          profile,
          command,
          "deny",
        ])
      for (const command of EVERYDAY) expect(decide("bash", command, HOSTILE, botPermission(profile))).toBe("ask")
    }
  })

  test("no shell where there is none to answer, and nothing written by a routine", () => {
    for (const profile of ["ask-outside", "no-shell", "read-only", "remote-none"] as const) {
      for (const command of [...BLOCKED, ...EVERYDAY])
        expect(decide("bash", command, HOSTILE, botPermission(profile))).toBe("deny")
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
      planner: ["deny", "deny", "deny"],
    }
    for (const profile of PROFILES) {
      const got = ["external_directory", "computer", "browser_control"].map((tool) =>
        decide(tool, "*", HOSTILE, botPermission(profile)),
      )
      expect([profile as string, ...got]).toEqual([profile, ...expected[profile]])
    }
  })

  test("never a subagent, plan mode or a question, in any profile", () => {
    for (const profile of PROFILES) {
      for (const tool of ["task", "plan_enter", "plan_exit", "question"])
        expect(decide(tool, "*", HOSTILE, botPermission(profile))).toBe("deny")
    }
  })

  test("no profile lets a bot write the server's configuration, however the path is spelled", () => {
    // Every tool that writes asks `edit`, with the path relative to the worktree as the model typed it.
    const CONFIG = [
      ".nikcli/tool/x.ts",
      ".nikcli\\tool\\x.ts",
      ".nikcli\\tool/x.ts",
      ".NIKCLI/tool/x.ts",
      ".NiKcLi\\agent\\altro.md",
      "./.nikcli/nikcli.json",
      "C:\\progetto\\.nikcli\\tool\\x.ts",
      "D:/altro/.nikcli/agent/bot.md",
      "..\\..\\fuori\\.nikcli\\tool\\x.ts",
      "nikcli.json",
      "NIKCLI.JSON",
      "nikcli.jsonc",
      "pacchetto/sotto/nikcli.jsonc",
      "pacchetto\\Nikcli.Jsonc",
      "C:\\progetto\\nikcli.json",
      "NIKCLI~1\\tool\\x.ts",
      "nikcli~1/nikcli.json",
      "NIKCLI~1.JSO",
      // The file's main stream on NTFS: the same file, under a name no pattern of it ends.
      "nikcli.json::$DATA",
      "NIKCLI.JSONC::$data",
      "C:\\progetto\\nikcli.json::$DATA",
      "sotto\\nikcli.json::$DATA",
    ]
    const PROJECT = [
      "src/index.ts",
      "src\\bots\\nikcli.ts",
      "src/bots/nikcli.test.ts",
      "packages/nikcli/src/x.ts",
      "docs/nikcli.md",
      ".github/workflows/ci.yml",
      ".vscode/settings.json",
      "config.json",
    ]
    for (const profile of PROFILES) {
      for (const path of CONFIG)
        expect([profile, path, decide("edit", path, HOSTILE, botPermission(profile))]).toEqual([profile, path, "deny"])
      // The rest of the project is as the profile had it: open, or closed to a routine.
      const open = profile === "read-only" || profile === "planner" ? "deny" : "allow"
      for (const path of PROJECT)
        expect([profile, path, decide("edit", path, HOSTILE, botPermission(profile))]).toEqual([profile, path, open])
    }
    // First among the session's, which all come after the bot's file: a routine's
    // `edit` denied whole stays the last, which is what hides the tool (`disabled`).
    const denials = configDenials()
    expect(
      botPermission("remote-none")
        .slice(0, denials.length)
        .map((entry) => entry.pattern),
    ).toEqual(denials)
    expect(botPermission("read-only").findLast((entry) => entry.permission === "edit")).toEqual({
      permission: "edit",
      pattern: "*",
      action: "deny",
    })
  })

  test("the note on the rules says an «always» for edits opens the configuration too", () => {
    // Given in the project, it comes after the session's rules and wins (bot-config-chiusa review).
    expect(itDict["bots.serve.rulesNote"]).toContain("nikcli.json")
    expect(enDict["bots.serve.rulesNote"]).toContain("nikcli.json")
  })

  test("the list: every form, deduplicated", () => {
    const list = blockedBashDenials()
    expect(new Set(list).size).toBe(list.length)
    for (const pattern of [
      "rm * ~",
      "sudo rm * / *",
      "rm -rf",
      "Remove-Item * ?:\\",
      "remove-item * ~",
      "FORMAT ?:*",
      "dd *of=/dev/*",
      "Remove-item * ?:\\",
    ])
      expect(list).toContain(pattern)
    expect(botPermission("ask").at(-1)!.permission).toBe("bash")
    expect(botPermission("ask").at(-1)!.action).toBe("deny")
  })

  test("a session is the bot's when its rules end with the profile's; another, or none, is not", () => {
    for (const profile of PROFILES) {
      expect(hasBotRules({ permission: [rule("*", "*", "ask"), ...botPermission(profile)] }, profile)).toBe(true)
      for (const other of PROFILES.filter((p) => p !== profile))
        expect(hasBotRules({ permission: [...botPermission(profile)] }, other)).toBe(false)
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

/*
 * The block list is written twice: ADE's (`approval.ts`, which ignores case)
 * and nikcli's own denials here. This keeps them together, as `pty.rs` did
 * while the list was its own: every rule has a command nikcli denies, and
 * every such command is blocked by ADE for the same rule.
 */
describe("the block list is the same in nikcli", () => {
  const SAMPLES: readonly (readonly [string, string])[] = [
    ["deleteRoot", "rm -rf /"],
    ["deleteRoot", "rm -rf /*"],
    ["deleteRoot", "rm -fr ~"],
    ["deleteRoot", "rm -rf ~/"],
    ["deleteRoot", "rm -r -f $HOME"],
    ["deleteRoot", "sudo rm -rf /"],
    ["deleteRoot", "/bin/rm -rf /"],
    ["deleteRoot", "\\rm -rf ~"],
    ["deleteRoot", 'rm -rf "/"'],
    ["deleteRoot", "rm -rf --no-preserve-root /"],
    ["deleteRoot", "rm -rf C:/"],
    ["deleteDrive", "Remove-Item -Recurse -Force C:\\"],
    ["deleteDrive", "rd /s /q C:\\"],
    ["deleteDrive", "del /s /q D:\\*"],
    ["disk", "mkfs.ext4 /dev/sda1"],
    ["disk", "diskpart"],
    ["disk", "format C:"],
    ["disk", "dd if=/dev/zero of=/dev/sda"],
    ["disk", "Clear-Disk -Number 0"],
    ["power", "shutdown /s /t 0"],
    ["power", "sudo reboot"],
    ["power", "Stop-Computer"],
    ["system", "bcdedit /deletevalue"],
    ["system", "vssadmin delete shadows /all"],
    ["system", "reg delete HKLM\\Software\\X"],
    ["deleteDrive", "Remove-item -Recurse -Force C:\\"],
    ["deleteDrive", "RD /S /Q C:\\"],
    ["power", "SHUTDOWN /s /t 0"],
    ["disk", "FORMAT C:"],
    ["deleteDrive", "Remove-Item -Recurse -Force ~"],
    ["deleteDrive", "Remove-Item -Recurse -Force $env:USERPROFILE"],
    ["deleteDrive", "Remove-Item C:\\"],
    ["deleteDrive", "rd /s /q %USERPROFILE%"],
    ["deleteDrive", "ri -r $HOME"],
  ]

  test("every sample is denied by nikcli in the profiles that ask, whatever the bot's file grants", () => {
    for (const profile of ["ask", "remote-ask"] as const) {
      for (const [, command] of SAMPLES)
        expect([profile, command, decide("bash", command, HOSTILE, botPermission(profile))]).toEqual([
          profile,
          command,
          "deny",
        ])
    }
  })

  test("every rule of BLOCKED has a sample, but the fork bomb", () => {
    const covered = new Set(SAMPLES.map(([rule]) => rule))
    for (const rule of BLOCK_RULES) {
      if (rule.id === "forkBomb") continue
      expect([rule.id, covered.has(rule.id)]).toEqual([rule.id, true])
    }
  })

  test("every sample is blocked by ADE too, for the same rule", () => {
    for (const [rule, command] of SAMPLES)
      expect([command, classifyCommand(command).blocked?.id]).toEqual([command, rule])
  })
})

describe("the planner's profile: a session with no tool at all", () => {
  test("a turn with no tools gets it, before any other profile", () => {
    expect(profileFor({ shell: true, noTools: true })).toBe("planner")
    expect(profileFor({ shell: false, noTools: true, approvals: true })).toBe("planner")
  })

  test("every tool is denied: edit, write, patch, webfetch, read, a shell, a search", () => {
    const rules = botPermission("planner" as BotProfile)
    for (const tool of ["edit", "write", "patch", "webfetch", "websearch", "read", "grep", "glob", "bash", "task"])
      expect([tool, decide(tool, "src/a.ts", HOSTILE, rules)]).toEqual([tool, "deny"])
  })
})
