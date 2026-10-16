import { describe, expect, it } from "bun:test"
import { PermissionRuleset } from "@/permission/ruleset"

/*
 * N1 (review of the review of the bots): the session's rules come after the agent's, and the last one that matches
 * wins, so the allows at the head of a bot's session (`read *`, `edit *`) opened what the agent shut: ragu's own
 * `read *.env: ask`, a bot file's `tools: { edit: false }`, a project's `read secrets/**: deny`. A bot's session of ADE
 * (it carries the `ade.bot` mark) may only restrict: the agent's rules are read, then the session's, and the stricter
 * of the two decisions stands (deny, then ask, then allow).
 */
const rule = (permission: string, pattern: string, action: PermissionRuleset.Rule["action"]): PermissionRuleset.Rule => ({
  permission,
  pattern,
  action,
})

// ragu's default agent, a bot file that says «no edit», and a project that closes a folder.
const AGENT: PermissionRuleset.Ruleset = [
  rule("*", "*", "allow"),
  rule("read", "*", "allow"),
  rule("read", "*.env", "ask"),
  rule("read", "*.env.*", "ask"),
  rule("read", "*.env.example", "allow"),
  rule("read", "secrets/**", "deny"),
  rule("edit", "*", "deny"),
]
// The head of a session that opens from a list, as `serve-rules.ts` writes it.
const SESSION: PermissionRuleset.Ruleset = [
  rule("ade.bot", "*", "deny"),
  rule("*", "*", "deny"),
  rule("read", "*", "allow"),
  rule("grep", "*", "allow"),
  rule("edit", "*", "allow"),
  rule("webfetch", "*", "ask"),
  rule("bash", "*", "deny"),
]

const decide = (agent: PermissionRuleset.Ruleset, session: PermissionRuleset.Ruleset, tool: string, pattern: string) =>
  PermissionRuleset.evaluate(tool, pattern, PermissionRuleset.merge(agent, session)).action

describe("a bot's session can only restrict", () => {
  it("does not open `.env` that ragu asks about", () => {
    expect(decide(AGENT, SESSION, "read", ".env")).toBe("ask")
    expect(decide(AGENT, SESSION, "read", "app/.env.local")).toBe("ask")
    expect(decide(AGENT, SESSION, "read", ".env.example")).toBe("allow")
    expect(decide(AGENT, SESSION, "read", "src/index.ts")).toBe("allow")
  })

  it("does not open what the project or the bot's file denied", () => {
    expect(decide(AGENT, SESSION, "read", "secrets/key.pem")).toBe("deny")
    expect(decide(AGENT, SESSION, "edit", "src/index.ts")).toBe("deny")
  })

  it("closes what the agent opens: `*: deny` of the session reaches tools it never named", () => {
    expect(decide(AGENT, SESSION, "mcp_github_create_issue", "*")).toBe("deny")
    expect(decide(AGENT, SESSION, "bash", "ls")).toBe("deny")
    expect(decide(AGENT, SESSION, "grep", "TODO")).toBe("allow")
    expect(decide(AGENT, SESSION, "webfetch", "https://example.com")).toBe("ask")
  })

  it("keeps the agent's asks: the session cannot turn them into allows", () => {
    const agent = [...AGENT, rule("bash", "*", "ask")]
    const session = [rule("ade.bot", "*", "deny"), rule("bash", "*", "allow")]
    expect(decide(agent, session, "bash", "ls")).toBe("ask")
  })

  it("lets the agent's allow through where the session says nothing", () => {
    const agent = [rule("*", "*", "allow")]
    const session = [rule("ade.bot", "*", "deny"), rule("bash", "rm *", "deny")]
    expect(decide(agent, session, "bash", "ls")).toBe("allow")
    expect(decide(agent, session, "bash", "rm x")).toBe("deny")
  })

  it("and a session without the mark is what it was: the last rule wins", () => {
    const session = SESSION.filter((entry) => entry.permission !== "ade.bot")
    expect(decide(AGENT, session, "read", ".env")).toBe("allow")
    expect(decide(AGENT, session, "edit", "src/index.ts")).toBe("allow")
  })

  it("hides a tool the agent denies whole, as a tool the session denies whole", () => {
    const agent: PermissionRuleset.Ruleset = [rule("*", "*", "allow"), rule("edit", "*", "deny")]
    expect(PermissionRuleset.disabled(["edit", "write", "read"], PermissionRuleset.merge(agent, SESSION))).toEqual(
      new Set(["edit", "write"]),
    )
    expect(PermissionRuleset.disabled(["bash", "mcp_x", "read"], PermissionRuleset.merge(agent, SESSION))).toEqual(
      new Set(["bash", "mcp_x"]),
    )
  })
})
