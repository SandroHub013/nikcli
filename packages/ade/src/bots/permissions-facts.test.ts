import { describe, expect, test } from "bun:test"
import type { PermissionRule } from "../chat/rules"
import { en } from "../i18n/en"
import { it as itDict } from "../i18n/it"
import { conversationText, phoneText, remoteNeverKey, routinesTextKey } from "./permissions-facts"
import type { AgentFile } from "./ragu"
import { runnerById, turnCommand } from "./runners"
import { botPermission, profileFor } from "./serve-rules"

/*
 * The Permissions tab's words are tied to the rules that decide a turn: the real spawn flags of Claude Code and
 * Codex (`turnCommand`) and the profiles ragu's server gets (`serve-rules.ts`). A rule that changes without the
 * words changing fails here (the review, P1-P1 and P2-P1).
 */
const bot = (runner: string, extra: Partial<AgentFile> = {}): AgentFile => ({
  identifier: "contabile",
  path: "C:/u/.nikcli/agent/contabile.md",
  scope: "global",
  description: "",
  mode: "primary",
  prompt: "",
  disabledTools: [],
  runner,
  ...extra,
})

const WHERE = [
  ["global", []],
  ["global", ["bash"]],
  ["global", ["edit", "write"]],
  ["project", []],
  ["project", ["edit", "write"]],
] as const

const bots = (runner: string) =>
  WHERE.map(([scope, disabledTools]) => bot(runner, { scope, disabledTools: [...disabledTools] }))

/** nikcli's wildcard, as `serve-rules.test.ts` copies it. */
function matches(value: string, pattern: string) {
  let escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp("^" + escaped + "$", "s").test(value)
}

const flag = (args: readonly string[], name: string) => {
  const at = args.indexOf(name)
  return at < 0 ? [] : (args[at + 1] ?? "").split(",")
}
const config = (args: readonly string[], key: string) =>
  args.find((arg) => arg.startsWith(`${key}="`))?.slice(key.length + 2, -1)

const claude = (b: AgentFile, spec: object = {}) => {
  const { args } = turnCommand(runnerById("claude"), { bot: b, message: "x", ...spec })
  const allowed = flag(args, "--allowedTools")
  return {
    shell: allowed.includes("Bash"),
    web: allowed.includes("WebFetch"),
    edits: args[args.indexOf("--permission-mode") + 1] === "acceptEdits",
    refusedShell: flag(args, "--disallowedTools").includes("Bash"),
  }
}
const codex = (b: AgentFile, spec: object = {}) => {
  const { args } = turnCommand(runnerById("codex"), { bot: b, message: "x", ...spec })
  return { sandbox: config(args, "sandbox_mode"), approval: config(args, "approval_policy") }
}

describe("«Nella Conversazione»: what each program really does", () => {
  test("Claude Code: Bash is pre-approved for a user's bot with a shell and refused otherwise, and edits follow the file", () => {
    for (const b of bots("claude")) {
      const real = claude(b)
      const said = conversationText(b)
      expect(said.key === "bots.permissions.panelTextClaude", `${b.scope} ${b.disabledTools}`).toBe(real.shell)
      expect(said.edits, `${b.scope} ${b.disabledTools}`).toBe(real.edits)
      // The text says the web is open; the flags agree unless the file turned it off.
      expect(real.web).toBe(true)
    }
  })

  test("Codex never asks (approval «never» for a user's bot), and a project's bot is read-only", () => {
    for (const b of bots("codex")) {
      const real = codex(b)
      const said = conversationText(b)
      expect(said.key === "bots.permissions.panelTextCodexWrite", `${b.scope} ${b.disabledTools}`).toBe(
        real.sandbox === "workspace-write",
      )
      expect(said.edits).toBe(real.sandbox === "workspace-write")
      if (b.scope === "global") expect(real.approval).toBe("never")
    }
  })

  test("ragu asks for the shell and for what is outside the project, and opens the rest", () => {
    const DEFAULTS: PermissionRule[] = [{ permission: "*", pattern: "*", action: "allow" }]
    const decide = (profile: Parameters<typeof botPermission>[0], permission: string, pattern = "*") =>
      [...DEFAULTS, ...botPermission(profile)].findLast(
        (rule) => matches(permission, rule.permission) && matches(pattern, rule.pattern),
      )?.action
    expect(profileFor({ approvals: true, shell: true })).toBe("ask")
    expect(decide("ask", "bash", "ls src")).toBe("ask")
    expect(decide("ask", "external_directory")).toBe("ask")
    expect(decide("ask", "webfetch")).toBe("allow")
    expect(decide("ask", "call_tool")).toBe("allow")
    expect(decide("ask", "edit")).toBe("allow")
    expect(profileFor({ approvals: true, shell: false })).toBe("ask-outside")
    expect(decide("ask-outside", "bash", "ls src")).toBe("deny")
    expect(conversationText(bot("ragu")).key).toBe("bots.permissions.panelTextRagu")
    expect(conversationText(bot("ragu", { disabledTools: ["bash"] })).key).toBe("bots.permissions.panelTextRaguNoShell")
  })

  test("the texts say what the rules say", () => {
    for (const catalog of [itDict, en] as Record<string, unknown>[]) {
      const word = (key: string) => String(catalog[key])
      // Only ragu is said to ask, and it says it opens MCP and the web.
      expect(word("bots.permissions.panelTextRagu")).toMatch(/MCP/)
      expect(word("bots.permissions.panelTextRagu")).toMatch(/web/i)
      for (const key of ["panelTextClaude", "panelTextClaudeNoShell", "panelTextCodexWrite", "panelTextCodexRead"]) {
        expect(word(`bots.permissions.${key}`), key).toMatch(/non può chiede|cannot ask/i)
      }
      expect(word("bots.permissions.panelTextClaude")).toMatch(/senza chiederti|without asking/)
      expect(word("bots.permissions.panelTextCodexRead")).toMatch(/lettura|read/)
    }
  })
})

describe("«Da telefono» and «Nelle routine»", () => {
  test("from a chat Claude Code has no shell and no web, Codex is read-only, whatever the file says", () => {
    for (const b of bots("claude")) {
      const real = claude(b, { remote: { commands: false }, lean: true })
      expect(real.shell).toBe(false)
      expect(real.refusedShell).toBe(true)
      expect(real.web).toBe(false)
      expect(phoneText(b).edits).toBe(real.edits)
    }
    for (const b of bots("codex")) {
      expect(codex(b, { remote: { commands: false } }).sandbox).toBe("read-only")
      expect(phoneText(b).edits).toBe(false)
    }
  })

  test("a bot that cannot write says it edits no file; one that can says so", () => {
    expect(phoneText(bot("ragu")).edits).toBe(true)
    expect(phoneText(bot("ragu", { disabledTools: ["edit", "write"] })).edits).toBe(false)
    expect(phoneText(bot("claude", { disabledTools: ["edit", "write"] })).edits).toBe(false)
  })

  test("in a routine Claude Code and Codex are read-only, with no shell", () => {
    for (const b of bots("claude")) {
      const real = claude(b, { unattended: true, lean: true })
      expect(real.shell).toBe(false)
      expect(real.edits).toBe(false)
      expect(real.web).toBe(false)
    }
    for (const b of bots("codex")) expect(codex(b, { unattended: true }).sandbox).toBe("read-only")
    expect(routinesTextKey(bot("claude"))).toBe("bots.permissions.routinesText")
    expect(routinesTextKey(bot("codex"))).toBe("bots.permissions.routinesTextCodex")
  })

  test("Codex is not said to run no commands, and its MCP and web are not said to be shut", () => {
    expect(remoteNeverKey(bot("codex"))).toBe("gateway.panel.remoteNeverCodex")
    expect(remoteNeverKey(bot("claude"))).toBe("gateway.panel.remoteNever")
    for (const key of ["bots.permissions.phoneTextCodex", "bots.permissions.routinesTextCodex"]) {
      expect(String(itDict[key as keyof typeof itDict]), key).not.toMatch(/non esegue comandi|non usa i server MCP/)
      expect(String(en[key as keyof typeof en]), key).not.toMatch(/runs no commands|uses no MCP/)
    }
    expect(phoneText(bot("codex")).key).toBe("bots.permissions.phoneTextCodex")
  })
})
